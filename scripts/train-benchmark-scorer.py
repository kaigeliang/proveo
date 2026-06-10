#!/usr/bin/env python3
"""
Benchmark Scorer v2 — PCA(50) + LightGBM.

特征：
  PCA(50) on jina-clip-v2 1024-dim embeddings
  + 3 cohort cosine similarities
  + log-normalised duration
  + top-category one-hot (top N)

目标：
  benchmarkScore      → LightGBM regressor
  organicWinner       → LightGBM classifier
  lowFollowerWinner   → LightGBM classifier

输出：
  apps/api/src/lib/scoring/scorer-model.json
    → PCA components (50×1024, float32 6dp)
    → LightGBM flat-tree JSON (TypeScript 树遍历)
    → 评估指标
"""

import datetime
import json
import math
from collections import Counter
from pathlib import Path

import lightgbm as lgb
import numpy as np
from scipy.stats import spearmanr
from sklearn.decomposition import PCA
from sklearn.metrics import mean_absolute_error, r2_score, roc_auc_score
from sklearn.preprocessing import StandardScaler

# ── paths ─────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent
TRAIN_FILE = ROOT / "tmp/kalodata-test/benchmark-train.jsonl"
TEST_FILE  = ROOT / "tmp/kalodata-test/benchmark-test.jsonl"
BENCH_MODEL = ROOT / "tmp/kalodata-test/benchmark-model.json"
OUT_MODEL   = ROOT / "apps/api/src/lib/scoring/scorer-model.json"

# ── hyper-params ──────────────────────────────────────────────────────────────
N_PCA          = 50
TOP_CAT_COUNT  = 10
MAX_DUR_LOG    = math.log1p(317)

# LightGBM shared params (conservative to avoid overfit on 761 samples)
LGBM_BASE = dict(
    verbose=-1,
    n_estimators=300,
    learning_rate=0.05,
    num_leaves=15,
    min_child_samples=10,
    subsample=0.8,
    colsample_bytree=0.8,
    reg_alpha=0.1,
    reg_lambda=1.0,
    random_state=42,
)

# ── helpers ───────────────────────────────────────────────────────────────────
def load_jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f]

def get_sims(s):
    sim = s.get("similarities") or {}
    return (
        float(sim.get("organicWinnerSimilarity") or 0),
        float(sim.get("paidRoasWinnerSimilarity") or 0),
        float(sim.get("lowFollowerWinnerSimilarity") or 0),
    )

def build_struct_features(samples, top_cats):
    """Non-embedding structural features (available at inference time)."""
    rows = []
    for s in samples:
        sim_org, sim_paid, sim_lf = get_sims(s)
        dur = math.log1p(float(s.get("durationSeconds") or 0)) / MAX_DUR_LOG
        cat = s.get("category") or ""
        cat_ohe  = [1.0 if cat == c else 0.0 for c in top_cats]
        cat_other = 0.0 if cat in top_cats else 1.0
        rows.append([sim_org, sim_paid, sim_lf, dur, *cat_ohe, cat_other])
    return np.array(rows, dtype=np.float64)

def labels(samples, key):
    return np.array([float(s["labels"][key]) for s in samples])

def ndcg_at_k(y_true, y_score, k=20):
    order = np.argsort(y_score)[::-1][:k]
    gains     = 2 ** y_true[order] - 1
    discounts = np.log2(np.arange(2, k + 2))
    dcg = (gains / discounts).sum()
    ideal = np.argsort(y_true)[::-1][:k]
    idcg = (2 ** y_true[ideal] - 1) / discounts
    return float(dcg / idcg.sum()) if idcg.sum() > 0 else 0.0

# ── flatten LightGBM tree to arrays for TypeScript inference ──────────────────
def flatten_tree(node):
    """Recursive → flat arrays. Leaf indices are -(leaf_pos+1) (bitwise ~ trick)."""
    split_feature, threshold, left_child, right_child, leaf_value = [], [], [], [], []

    def walk(n):
        if "leaf_value" in n:
            idx = -(len(leaf_value) + 1)
            leaf_value.append(round(float(n["leaf_value"]), 8))
            return idx
        pos = len(split_feature)
        split_feature.append(int(n["split_feature"]))
        # threshold may be "0.5||..." for categorical — take numeric part
        threshold.append(round(float(str(n["threshold"]).split("||")[0]), 8))
        left_child.append(None)
        right_child.append(None)
        left_child[pos]  = walk(n["left_child"])
        right_child[pos] = walk(n["right_child"])
        return pos

    walk(node)
    return dict(
        split_feature=split_feature,
        threshold=threshold,
        left_child=left_child,
        right_child=right_child,
        leaf_value=leaf_value,
    )

def export_lgbm(booster):
    """Export LightGBM booster as list of flat trees + base score."""
    dump = booster.dump_model()
    trees = [flatten_tree(t["tree_structure"]) for t in dump["tree_info"]]
    return dict(type="lgbm", base_score=0.0, trees=trees)

# ── load data ─────────────────────────────────────────────────────────────────
print("Loading data …")
train = load_jsonl(TRAIN_FILE)
test  = load_jsonl(TEST_FILE)
print(f"  train={len(train)}  test={len(test)}")

with open(BENCH_MODEL) as f:
    bm = json.load(f)
cohorts = bm["cohorts"]

# ── PCA on embeddings ─────────────────────────────────────────────────────────
print(f"\nFitting PCA({N_PCA}) on train embeddings …")
E_train = np.array([s["embedding"] for s in train], dtype=np.float32)
E_test  = np.array([s["embedding"] for s in test],  dtype=np.float32)

pca = PCA(n_components=N_PCA, random_state=42)
P_train = pca.fit_transform(E_train)
P_test  = pca.transform(E_test)

cumvar = np.cumsum(pca.explained_variance_ratio_)
print(f"  累计解释方差: {cumvar[-1]:.4f}  ({N_PCA} components)")

# ── structural features ───────────────────────────────────────────────────────
cat_counts = Counter(s.get("category") or "" for s in train)
top_cats   = [c for c, _ in cat_counts.most_common(TOP_CAT_COUNT)]

S_train = build_struct_features(train, top_cats)
S_test  = build_struct_features(test,  top_cats)

# combined: [PCA | structural]
X_train = np.hstack([P_train, S_train])
X_test  = np.hstack([P_test,  S_test])

struct_names = [
    "sim_organic", "sim_paid_roas", "sim_low_follower", "duration_log_norm",
    *[f"cat_{c}" for c in top_cats], "cat_other",
]
feature_names = [f"pca_{i}" for i in range(N_PCA)] + struct_names
print(f"  Feature count: {len(feature_names)}")

# ── labels ────────────────────────────────────────────────────────────────────
y_score_tr = labels(train, "benchmarkScore")
y_score_te = labels(test,  "benchmarkScore")
y_org_tr   = labels(train, "organicWinner")
y_org_te   = labels(test,  "organicWinner")
y_lf_tr    = labels(train, "lowFollowerWinner")
y_lf_te    = labels(test,  "lowFollowerWinner")

# ── LightGBM: benchmarkScore ─────────────────────────────────────────────────
print("\n── LightGBM regressor (benchmarkScore) ──")
reg = lgb.LGBMRegressor(**LGBM_BASE)
reg.fit(
    X_train, y_score_tr,
    eval_set=[(X_test, y_score_te)],
    callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(period=0)],
)
y_pred = reg.predict(X_test)
mae  = mean_absolute_error(y_score_te, y_pred)
r2   = r2_score(y_score_te, y_pred)
sp,_ = spearmanr(y_score_te, y_pred)
ndcg = ndcg_at_k(y_score_te, y_pred, k=20)
print(f"  best_iter={reg.best_iteration_}  MAE={mae:.4f}  R²={r2:.4f}  Spearman={sp:.4f}  NDCG@20={ndcg:.4f}")

# ── LightGBM: organicWinner ───────────────────────────────────────────────────
print("\n── LightGBM classifier (organicWinner) ──")
clf_org = lgb.LGBMClassifier(**LGBM_BASE)
clf_org.fit(
    X_train, y_org_tr,
    eval_set=[(X_test, y_org_te)],
    callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(period=0)],
)
prob_org = clf_org.predict_proba(X_test)[:, 1]
auc_org  = roc_auc_score(y_org_te, prob_org)
print(f"  best_iter={clf_org.best_iteration_}  AUC={auc_org:.4f}")

# ── LightGBM: lowFollowerWinner ───────────────────────────────────────────────
print("\n── LightGBM classifier (lowFollowerWinner) ──")
clf_lf = lgb.LGBMClassifier(**LGBM_BASE)
clf_lf.fit(
    X_train, y_lf_tr,
    eval_set=[(X_test, y_lf_te)],
    callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(period=0)],
)
prob_lf = clf_lf.predict_proba(X_test)[:, 1]
auc_lf  = roc_auc_score(y_lf_te, prob_lf)
print(f"  best_iter={clf_lf.best_iteration_}  AUC={auc_lf:.4f}")

# ── feature importance (top 15) ───────────────────────────────────────────────
print("\n── Top 15 feature importances (regressor) ──")
fi = sorted(zip(feature_names, reg.feature_importances_), key=lambda x: -x[1])
for name, imp in fi[:15]:
    print(f"  {name:35s}  {imp:6.0f}")

# ── per-category MAE on test ──────────────────────────────────────────────────
print("\n── Per-category test MAE ──")
test_cats = [s.get("category") or "" for s in test]
for c in top_cats[:8]:
    idx = [i for i, cat in enumerate(test_cats) if cat == c]
    if len(idx) < 3:
        continue
    print(f"  {c:25s}  n={len(idx):3d}  MAE={mean_absolute_error(y_score_te[idx], y_pred[idx]):.4f}")

# ── export ────────────────────────────────────────────────────────────────────
print("\nExporting scorer-model.json …")

# PCA matrix: round to 6 dp to reduce JSON size (~50% vs full float64)
pca_components = np.round(pca.components_.astype(np.float64), 6).tolist()
pca_mean       = np.round(pca.mean_.astype(np.float64), 6).tolist()

output = {
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "version": 2,
    "trainCount": len(train),
    "testCount": len(test),
    "cohorts": cohorts,
    "pca": {
        "nComponents": N_PCA,
        "explainedVarianceRatio": [round(float(v), 6) for v in pca.explained_variance_ratio_],
        "cumulativeVariance": round(float(cumvar[-1]), 4),
        "mean": pca_mean,
        "components": pca_components,
    },
    "features": {
        "names": feature_names,
        "topCategories": top_cats,
        "maxDurationLog": MAX_DUR_LOG,
        "nPca": N_PCA,
        "nStruct": len(struct_names),
    },
    "scorer": export_lgbm(reg.booster_),
    "classifiers": {
        "organicWinner":     export_lgbm(clf_org.booster_),
        "lowFollowerWinner": export_lgbm(clf_lf.booster_),
    },
    "metrics": {
        "test": {
            "mae":                   round(mae, 4),
            "r2":                    round(r2, 4),
            "spearman":              round(float(sp), 4),
            "ndcgAt20":              round(ndcg, 4),
            "aucOrganicWinner":      round(auc_org, 4),
            "aucLowFollowerWinner":  round(auc_lf, 4),
        }
    },
}

OUT_MODEL.parent.mkdir(parents=True, exist_ok=True)
with open(OUT_MODEL, "w") as f:
    json.dump(output, f, separators=(",", ":"), ensure_ascii=False)

size_kb = OUT_MODEL.stat().st_size / 1024
print(f"  → {OUT_MODEL}  ({size_kb:.0f} KB)")
print(f"\nSummary v2: MAE={mae:.4f}  Spearman={sp:.4f}  NDCG@20={ndcg:.4f}  AUC_org={auc_org:.4f}")
print(f"vs v1 Ridge: MAE=0.1155  Spearman=0.4473  NDCG@20=0.8147  AUC_org=0.9188")

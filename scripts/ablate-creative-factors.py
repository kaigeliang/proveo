#!/usr/bin/env python3
"""创意因子消融 + 因子归因导出。

对比 A 基线(CLIP) / B 仅 Qwen 因子 / C 融合，验证 Qwen 创意因子对爆款预测是否有增量；
并以 creator-disjoint 切分（防达人泄漏）输出因子单变量 lift 归因。

输入：scripts/export-scorer-dataset.mjs 导出的 dataset.jsonl
输出：
  - 控制台：A/B/C 指标表 + 因子 lift 排名
  - apps/api/src/lib/scoring/factor-attribution.json（提交产物，供生成引导/看板消费）

用法：
  npm run ml:ablate
  python3 scripts/ablate-creative-factors.py --dataset tmp/ml-ablation/dataset.jsonl
"""
import argparse
import datetime
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

import lightgbm as lgb
import numpy as np
from scipy.stats import spearmanr
from sklearn.decomposition import PCA
from sklearn.metrics import mean_absolute_error, r2_score, roc_auc_score

ROOT = Path(__file__).parent.parent
N_PCA = 50
MAX_DUR_LOG = math.log1p(317)
MIN_FACTOR_COUNT = 5
TEST_BUCKET = 0  # creatorHandle hash % 5 == 0 → test (~20%)
LGBM = dict(
    verbose=-1, n_estimators=200, learning_rate=0.05, num_leaves=15,
    min_child_samples=10, subsample=0.8, colsample_bytree=0.8,
    reg_alpha=0.1, reg_lambda=1.0, random_state=42,
)


def creator_bucket(handle):
    return int(hashlib.md5((handle or "NA").encode()).hexdigest(), 16) % 5


def ndcg_at_k(y_true, y_score, k=20):
    order = np.argsort(y_score)[::-1][:k]
    disc = np.log2(np.arange(2, k + 2))
    dcg = ((2 ** y_true[order] - 1) / disc).sum()
    ideal = np.argsort(y_true)[::-1][:k]
    idcg = ((2 ** y_true[ideal] - 1) / disc).sum()
    return float(dcg / idcg) if idcg > 0 else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(ROOT / "tmp/ml-ablation/dataset.jsonl"))
    ap.add_argument("--attribution-out", default=str(ROOT / "apps/api/src/lib/scoring/factor-attribution.json"))
    args = ap.parse_args()

    rows = [json.loads(line) for line in open(args.dataset)]
    tr = [r for r in rows if creator_bucket(r["creatorHandle"]) != TEST_BUCKET]
    te = [r for r in rows if creator_bucket(r["creatorHandle"]) == TEST_BUCKET]
    overlap = set(r["creatorHandle"] for r in tr) & set(r["creatorHandle"] for r in te)
    print(f"rows={len(rows)} creator-disjoint train={len(tr)} test={len(te)} creatorOverlap={len(overlap)}")

    E_tr = np.array([r["embedding"] for r in tr], dtype=np.float32)
    E_te = np.array([r["embedding"] for r in te], dtype=np.float32)
    pca = PCA(n_components=N_PCA, random_state=42)
    P_tr, P_te = pca.fit_transform(E_tr), pca.transform(E_te)

    top_cats = [c for c, _ in Counter(r["category"] for r in tr).most_common(10)]

    def struct(rs):
        out = []
        for r in rs:
            dur = math.log1p(r["durationSeconds"]) / MAX_DUR_LOG
            ohe = [1.0 if r["category"] == c else 0.0 for c in top_cats]
            out.append([dur, *ohe, 0.0 if r["category"] in top_cats else 1.0])
        return np.array(out)

    S_tr, S_te = struct(tr), struct(te)

    fc = Counter(f for r in tr for f in r["qwenFactorIds"])
    vocab = sorted(f for f, c in fc.items() if c >= MIN_FACTOR_COUNT)
    fidx = {f: i for i, f in enumerate(vocab)}

    def qfeat(rs):
        x = np.zeros((len(rs), len(vocab)))
        for i, r in enumerate(rs):
            for f in r["qwenFactorIds"]:
                if f in fidx:
                    x[i, fidx[f]] = 1.0
        return x

    Q_tr, Q_te = qfeat(tr), qfeat(te)
    A_tr, A_te = np.hstack([P_tr, S_tr]), np.hstack([P_te, S_te])
    C_tr, C_te = np.hstack([A_tr, Q_tr]), np.hstack([A_te, Q_te])
    print(f"PCA(50) cumvar={pca.explained_variance_ratio_.sum():.3f} | qwen vocab(count>={MIN_FACTOR_COUNT})={len(vocab)}")

    def col(rs, k):
        return np.array([r[k] for r in rs], dtype=float)

    ybs_tr, ybs_te = col(tr, "benchmarkScore"), col(te, "benchmarkScore")
    yo_tr, yo_te = col(tr, "organicWinner"), col(te, "organicWinner")
    feats = {"A baseline(CLIP)": (A_tr, A_te), "B qwen-factors": (Q_tr, Q_te), "C fusion": (C_tr, C_te)}

    metrics = {}
    print(f"\n=== benchmarkScore 回归 / organicWinner 分类 ===")
    print(f"{'model':<18}{'Spearman':>10}{'NDCG@20':>10}{'R²':>8}{'AUC_org':>9}")
    for name, (Xtr, Xte) in feats.items():
        reg = lgb.LGBMRegressor(**LGBM).fit(Xtr, ybs_tr)
        pr = reg.predict(Xte)
        sp = float(spearmanr(ybs_te, pr)[0])
        nd = ndcg_at_k(ybs_te, pr)
        r2 = float(r2_score(ybs_te, pr))
        auc = None
        if len(set(yo_te)) > 1:
            clf = lgb.LGBMClassifier(**LGBM).fit(Xtr, yo_tr)
            auc = float(roc_auc_score(yo_te, clf.predict_proba(Xte)[:, 1]))
        metrics[name] = dict(spearman=round(sp, 4), ndcgAt20=round(nd, 4), r2=round(r2, 4),
                             aucOrganicWinner=round(auc, 4) if auc is not None else None)
        print(f"{name:<18}{sp:>10.4f}{nd:>10.4f}{r2:>8.4f}{(auc if auc else float('nan')):>9.4f}")

    # 因子单变量 lift（关联，非因果）
    lifts = []
    for f in vocab:
        with_v = [r["benchmarkScore"] for r in tr if f in r["qwenFactorIds"]]
        without_v = [r["benchmarkScore"] for r in tr if f not in r["qwenFactorIds"]]
        if len(with_v) >= MIN_FACTOR_COUNT and len(without_v) >= MIN_FACTOR_COUNT:
            lifts.append(dict(factorId=f, lift=round(float(np.mean(with_v) - np.mean(without_v)), 4),
                              sampleSize=len(with_v),
                              direction="positive" if np.mean(with_v) >= np.mean(without_v) else "negative"))
    lifts.sort(key=lambda x: -x["lift"])
    print("\n=== 因子 lift top/bottom（关联，非因果）===")
    for r in lifts[:6]:
        print(f"  {r['lift']:+.4f} (n={r['sampleSize']:4d}) {r['factorId']}")
    print("  ...")
    for r in lifts[-5:]:
        print(f"  {r['lift']:+.4f} (n={r['sampleSize']:4d}) {r['factorId']}")

    attribution = dict(
        generatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        method="univariate-lift-on-benchmarkScore",
        caution="associational not causal; not category/product controlled",
        split="creator-disjoint",
        trainCount=len(tr), testCount=len(te),
        ablation=metrics,
        factors=lifts,
    )
    out = Path(args.attribution_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(attribution, ensure_ascii=False, indent=2))
    print(f"\n→ wrote {out.relative_to(ROOT)} ({len(lifts)} factors)")


if __name__ == "__main__":
    main()

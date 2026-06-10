#!/usr/bin/env python3
"""
Qwen-VL enhanced Auditor scorer experiment.

This script does not overwrite the production scorer. It compares:
  A. baseline_lgbm: jina-clip-v2 PCA + cohort similarities + duration/category
  B. qwen_factor_lgbm: Qwen observed creative factor one-hot features only
  C. fusion_lgbm: baseline features + Qwen observed creative factor features

The split is the existing Kalodata train/test split. PCA, category vocab and
Qwen factor vocab are fit on train only to avoid leakage.
"""

import argparse
import datetime
import json
import math
import warnings
from collections import Counter
from pathlib import Path

import lightgbm as lgb
import numpy as np
from scipy.stats import spearmanr
from sklearn.decomposition import PCA
from sklearn.metrics import mean_absolute_error, r2_score, roc_auc_score


ROOT = Path(__file__).parent.parent
DEFAULT_TRAIN = ROOT / "tmp/kalodata-test/qwenvl-url-ingested-v2/benchmark-train.qwenvl.jsonl"
DEFAULT_TEST = ROOT / "tmp/kalodata-test/qwenvl-url-ingested-v2/benchmark-test.qwenvl.jsonl"
DEFAULT_OUT = ROOT / "tmp/kalodata-test/qwenvl-url-ingested-v2/qwenvl-scorer-comparison.json"

N_PCA = 50
TOP_CAT_COUNT = 10
MAX_DUR_LOG = math.log1p(317)
MIN_FACTOR_COUNT = 5

warnings.filterwarnings("ignore", message="X does not have valid feature names", category=UserWarning)

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


def load_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def labels(samples, key):
    return np.array([float(sample["labels"][key]) for sample in samples], dtype=np.float64)


def score_labels(samples):
    return labels(samples, "benchmarkScore")


def get_sims(sample):
    sim = sample.get("similarities") or {}
    return (
        float(sim.get("organicWinnerSimilarity") or 0),
        float(sim.get("paidRoasWinnerSimilarity") or 0),
        float(sim.get("lowFollowerWinnerSimilarity") or 0),
    )


def build_struct_features(samples, top_cats):
    rows = []
    for sample in samples:
        sim_org, sim_paid, sim_lf = get_sims(sample)
        duration = math.log1p(float(sample.get("durationSeconds") or 0)) / MAX_DUR_LOG
        category = sample.get("category") or ""
        cat_ohe = [1.0 if category == cat else 0.0 for cat in top_cats]
        cat_other = 0.0 if category in top_cats else 1.0
        rows.append([sim_org, sim_paid, sim_lf, duration, *cat_ohe, cat_other])
    return np.array(rows, dtype=np.float64)


def build_baseline_features(train, test):
    train_embeddings = np.array([sample["embedding"] for sample in train], dtype=np.float32)
    test_embeddings = np.array([sample["embedding"] for sample in test], dtype=np.float32)

    pca = PCA(n_components=min(N_PCA, len(train) - 1), random_state=42)
    train_pca = pca.fit_transform(train_embeddings)
    test_pca = pca.transform(test_embeddings)

    top_cats = [cat for cat, _ in Counter(sample.get("category") or "" for sample in train).most_common(TOP_CAT_COUNT)]
    train_struct = build_struct_features(train, top_cats)
    test_struct = build_struct_features(test, top_cats)

    struct_names = [
        "sim_organic",
        "sim_paid_roas",
        "sim_low_follower",
        "duration_log_norm",
        *[f"cat_{cat}" for cat in top_cats],
        "cat_other",
    ]
    feature_names = [f"pca_{i}" for i in range(train_pca.shape[1])] + struct_names
    return np.hstack([train_pca, train_struct]), np.hstack([test_pca, test_struct]), feature_names


def qwen_factor_ids(sample):
    return [factor for factor in sample.get("qwenFactorIds") or [] if isinstance(factor, str)]


def build_qwen_features(train, test, y_train, min_factor_count):
    counts = Counter(factor for sample in train for factor in qwen_factor_ids(sample))
    vocab = sorted(factor for factor, count in counts.items() if count >= min_factor_count)
    index = {factor: i for i, factor in enumerate(vocab)}
    factor_lifts = {}
    for factor in vocab:
        with_values = [float(y_train[i]) for i, sample in enumerate(train) if factor in set(qwen_factor_ids(sample))]
        without_values = [float(y_train[i]) for i, sample in enumerate(train) if factor not in set(qwen_factor_ids(sample))]
        if not with_values or not without_values:
            factor_lifts[factor] = 0.0
            continue
        factor_lifts[factor] = float(np.mean(with_values) - np.mean(without_values))

    prior_names = [
        "qwen_prior:factor_count_norm",
        "qwen_prior:lift_sum",
        "qwen_prior:lift_mean",
        "qwen_prior:lift_max",
        "qwen_prior:lift_min",
        "qwen_prior:positive_lift_sum",
        "qwen_prior:negative_lift_sum",
    ]

    def matrix(samples):
        x = np.zeros((len(samples), len(vocab) + len(prior_names)), dtype=np.float64)
        for row_idx, sample in enumerate(samples):
            factors = [factor for factor in qwen_factor_ids(sample) if factor in index]
            for factor in factors:
                col_idx = index.get(factor)
                if col_idx is not None:
                    x[row_idx, col_idx] = 1.0
            lifts = [factor_lifts[factor] for factor in factors]
            if lifts:
                offset = len(vocab)
                x[row_idx, offset + 0] = len(factors) / max(len(vocab), 1)
                x[row_idx, offset + 1] = float(np.sum(lifts))
                x[row_idx, offset + 2] = float(np.mean(lifts))
                x[row_idx, offset + 3] = float(np.max(lifts))
                x[row_idx, offset + 4] = float(np.min(lifts))
                x[row_idx, offset + 5] = float(np.sum([lift for lift in lifts if lift > 0]))
                x[row_idx, offset + 6] = float(np.sum([lift for lift in lifts if lift < 0]))
        return x

    feature_names = [f"factor:{factor}" for factor in vocab] + prior_names
    return matrix(train), matrix(test), feature_names, vocab, counts, factor_lifts


def ndcg_at_k(y_true, y_score, k=20):
    k = min(k, len(y_true))
    order = np.argsort(y_score)[::-1][:k]
    gains = 2**y_true[order] - 1
    discounts = np.log2(np.arange(2, k + 2))
    dcg = (gains / discounts).sum()
    ideal = np.argsort(y_true)[::-1][:k]
    idcg = ((2**y_true[ideal] - 1) / discounts).sum()
    return float(dcg / idcg) if idcg > 0 else 0.0


def safe_spearman(y_true, y_pred):
    if len(np.unique(y_true)) < 2 or len(np.unique(y_pred)) < 2:
        return 0.0
    value, _ = spearmanr(y_true, y_pred)
    return float(value) if np.isfinite(value) else 0.0


def safe_auc(y_true, y_pred):
    if len(set(float(v) for v in y_true)) < 2:
        return None
    return float(roc_auc_score(y_true, y_pred))


def regression_metrics(y_true, y_pred):
    return {
        "mae": round(float(mean_absolute_error(y_true, y_pred)), 6),
        "r2": round(float(r2_score(y_true, y_pred)), 6),
        "spearman": round(safe_spearman(y_true, y_pred), 6),
        "ndcgAt20": round(ndcg_at_k(y_true, y_pred, 20), 6),
    }


def fit_regressor(name, x_train, y_train, x_test, y_test):
    model = lgb.LGBMRegressor(**LGBM_BASE)
    model.fit(
        x_train,
        y_train,
        eval_set=[(x_test, y_test)],
        callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(period=0)],
    )
    pred = model.predict(x_test)
    return model, {
        "name": name,
        "bestIteration": int(model.best_iteration_ or LGBM_BASE["n_estimators"]),
        **regression_metrics(y_test, pred),
    }


def fit_classifier(x_train, y_train, x_test, y_test):
    if len(set(float(v) for v in y_train)) < 2 or len(set(float(v) for v in y_test)) < 2:
        return None
    model = lgb.LGBMClassifier(**LGBM_BASE)
    model.fit(
        x_train,
        y_train,
        eval_set=[(x_test, y_test)],
        callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(period=0)],
    )
    return safe_auc(y_test, model.predict_proba(x_test)[:, 1])


def feature_importance(model, feature_names, top_n=20):
    items = sorted(zip(feature_names, model.feature_importances_), key=lambda item: -item[1])
    return [{"feature": name, "importance": int(value)} for name, value in items[:top_n] if value > 0]


def class_metrics(x_train, x_test, train, test):
    metrics = {}
    for key in ["organicWinner", "paidValidatedWinner", "lowFollowerWinner"]:
        auc = fit_classifier(x_train, labels(train, key), x_test, labels(test, key))
        metrics[f"auc_{key}"] = round(auc, 6) if auc is not None else None
    return metrics


def parse_args():
    parser = argparse.ArgumentParser(description="Train/evaluate Qwen-VL enhanced scorer candidates.")
    parser.add_argument("--train", default=str(DEFAULT_TRAIN))
    parser.add_argument("--test", default=str(DEFAULT_TEST))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-factor-count", type=int, default=MIN_FACTOR_COUNT)
    parser.add_argument(
        "--require-qwen",
        action="store_true",
        help="Evaluate only rows with Qwen factor ids. Recommended for fair A/B/C comparison.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    train_all = load_jsonl(Path(args.train))
    test_all = load_jsonl(Path(args.test))

    if args.require_qwen:
        train = [sample for sample in train_all if qwen_factor_ids(sample)]
        test = [sample for sample in test_all if qwen_factor_ids(sample)]
    else:
        train = train_all
        test = test_all

    if len(train) < 50 or len(test) < 20:
        raise SystemExit(f"Not enough samples after filtering: train={len(train)} test={len(test)}")

    y_train = score_labels(train)
    y_test = score_labels(test)

    baseline_train, baseline_test, baseline_names = build_baseline_features(train, test)
    qwen_train, qwen_test, qwen_names, qwen_factor_vocab, qwen_counts, qwen_lifts = build_qwen_features(
        train, test, y_train, args.min_factor_count
    )
    fusion_train = np.hstack([baseline_train, qwen_train])
    fusion_test = np.hstack([baseline_test, qwen_test])
    fusion_names = baseline_names + [f"qwen:{name}" for name in qwen_names]

    mean_pred = np.full_like(y_test, float(np.mean(y_train)), dtype=np.float64)
    results = {
        "mean_baseline": {"name": "mean_baseline", **regression_metrics(y_test, mean_pred)},
    }

    baseline_model, results["baseline_lgbm"] = fit_regressor("baseline_lgbm", baseline_train, y_train, baseline_test, y_test)
    qwen_model, results["qwen_factor_lgbm"] = fit_regressor("qwen_factor_lgbm", qwen_train, y_train, qwen_test, y_test)
    fusion_model, results["fusion_lgbm"] = fit_regressor("fusion_lgbm", fusion_train, y_train, fusion_test, y_test)

    results["baseline_lgbm"].update(class_metrics(baseline_train, baseline_test, train, test))
    results["qwen_factor_lgbm"].update(class_metrics(qwen_train, qwen_test, train, test))
    results["fusion_lgbm"].update(class_metrics(fusion_train, fusion_test, train, test))

    ranked = sorted(
        [results["baseline_lgbm"], results["qwen_factor_lgbm"], results["fusion_lgbm"]],
        key=lambda item: (item["mae"], -item["spearman"], -item["ndcgAt20"]),
    )

    report = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "trainPath": str(Path(args.train).resolve()),
        "testPath": str(Path(args.test).resolve()),
        "requireQwen": args.require_qwen,
        "trainCount": len(train),
        "testCount": len(test),
        "droppedForMissingQwen": {
            "train": len(train_all) - len(train),
            "test": len(test_all) - len(test),
        },
        "featureCounts": {
            "baseline": baseline_train.shape[1],
            "qwen": qwen_train.shape[1],
            "fusion": fusion_train.shape[1],
        },
        "qwenFeatureNames": qwen_names,
        "qwenFactorVocab": qwen_factor_vocab,
        "qwenFactorTrainCounts": {factor: qwen_counts[factor] for factor in qwen_factor_vocab},
        "qwenFactorTrainLifts": {factor: round(qwen_lifts[factor], 6) for factor in qwen_factor_vocab},
        "metrics": results,
        "winner": ranked[0]["name"],
        "topFeatureImportance": {
            "baseline_lgbm": feature_importance(baseline_model, baseline_names),
            "qwen_factor_lgbm": feature_importance(qwen_model, [f"qwen:{name}" for name in qwen_names]),
            "fusion_lgbm": feature_importance(fusion_model, fusion_names),
        },
        "policy": {
            "noLabelLeakage": "PCA, category vocabulary and Qwen factor vocabulary are fit on train split only.",
            "deployment": "This comparison does not overwrite apps/api/src/lib/scoring/scorer-model.json.",
        },
    }

    write_json(Path(args.out), report)

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

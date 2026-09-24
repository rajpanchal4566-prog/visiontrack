/**
 * VisionTrack — Feature 3B Real-World Benchmark Runner
 *
 * Evaluates the untouched 1,696 Indian license plate benchmark crops:
 * Baseline: Feature 1 + Feature 2 + models/license-plate-ocr.onnx
 * New:      Feature 1 + Feature 2 + models/license-plate-ocr-india-finetuned.onnx
 *
 * Generates all 17 required breakdown metrics, confusion matrices, and comparison artifacts.
 */

const fs = require('fs');
const path = require('path');
const { enhanceAndRecognizePlate } = require('../server/services/plateEnhancementService');
const { shutdownNeuralOcr } = require('../server/services/neuralPlateOcr');
const { normalizePlateText } = require('../server/services/plateNormalizer');

const BENCHMARK_DIR = 'D:\\Download\\ANPR_BENCHMARK';
const GROUND_TRUTH_CSV = path.join(BENCHMARK_DIR, 'benchmark_ground_truth.csv');
const BASELINE_MODEL_PATH = path.resolve(__dirname, '..', 'models', 'license-plate-ocr.onnx');
const FINETUNED_MODEL_PATH = path.resolve(__dirname, '..', 'models', 'license-plate-ocr-india-finetuned.onnx');

function parseCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let cur = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(cur.trim());
        cur = '';
      } else {
        cur += char;
      }
    }
    values.push(cur.trim());
    const row = {};
    for (let h = 0; h < headers.length; h++) {
      row[headers[h]] = values[h] !== undefined ? values[h].replace(/^"|"$/g, '') : '';
    }
    rows.push(row);
  }
  return rows;
}

function levenshteinDistance(s1, s2) {
  if (s1.length < s2.length) return levenshteinDistance(s2, s1);
  if (s2.length === 0) return s1.length;
  let previousRow = Array.from({ length: s2.length + 1 }, (_, i) => i);
  for (let i = 0; i < s1.length; i++) {
    const currentRow = [i + 1];
    for (let j = 0; j < s2.length; j++) {
      const insertions = previousRow[j + 1] + 1;
      const deletions = currentRow[j] + 1;
      const substitutions = previousRow[j] + (s1[i] !== s2[j] ? 1 : 0);
      currentRow.push(Math.min(insertions, deletions, substitutions));
    }
    previousRow = currentRow;
  }
  return previousRow[previousRow.length - 1];
}

async function runEvaluation(modelPath, modelLabel, records) {
  console.log(`\n==================================================`);
  console.log(`Evaluating: ${modelLabel}`);
  console.log(`Model Path: ${modelPath}`);
  console.log(`==================================================`);

  // Set environment variable for the model path
  process.env.OCR_MODEL_PATH = modelPath;
  await shutdownNeuralOcr();

  const results = [];
  const latencies = [];
  let exactCount = 0;
  let normCount = 0;
  let totalDist = 0;
  let totalGtLen = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const cropPath = r.crop_path;
    const gt = (r.ground_truth_plate || '').trim().toUpperCase();
    const stateCode = r.state_code || gt.slice(0, 2);

    if (!fs.existsSync(cropPath)) {
      continue;
    }

    const cropBuf = fs.readFileSync(cropPath);
    const t0 = performance.now();
    const res = await enhanceAndRecognizePlate(cropBuf);
    const t1 = performance.now();
    const latency = t1 - t0;
    latencies.push(latency);

    const pred = (res.plate || '').trim().toUpperCase();
    const normPredObj = normalizePlateText(pred);
    const normGtObj = normalizePlateText(gt);
    const normPred = (normPredObj.plate || pred).trim().toUpperCase();
    const normGt = (normGtObj.plate || gt).trim().toUpperCase();

    const isExact = pred === gt;
    const isNormMatch = normPred === normGt && normGt.length > 0;
    const dist = levenshteinDistance(pred, gt);

    if (isExact) exactCount++;
    if (isNormMatch) normCount++;
    totalDist += dist;
    totalGtLen += gt.length;

    // Metadata for breakdown
    const width = parseInt(r.xmax, 10) - parseInt(r.xmin, 10);
    const height = parseInt(r.ymax, 10) - parseInt(r.ymin, 10);
    const isTwoLine = height > 0 && (width / height) < 2.5;

    let resTier = '>200 px';
    if (width < 50) resTier = '<50 px';
    else if (width < 100) resTier = '50–100 px';
    else if (width < 200) resTier = '100–200 px';

    let source = 'unknown';
    if (r.image_path.includes('google_images')) source = 'google_images';
    else if (r.image_path.includes('State-wise_OLX')) source = 'State-wise_OLX';
    else if (r.image_path.includes('video_images') || r.image_path.includes('video8')) source = 'video_images';

    results.push({
      index: i,
      image_path: r.image_path,
      crop_path: cropPath,
      ground_truth: gt,
      prediction: pred,
      normalized_gt: normGt,
      normalized_pred: normPred,
      is_exact: isExact,
      is_norm_match: isNormMatch,
      edit_distance: dist,
      latency_ms: Number(latency.toFixed(2)),
      width,
      height,
      is_two_line: isTwoLine,
      res_tier: resTier,
      source,
      state_code: stateCode,
      method_chosen: res.enhancementMethod || 'Original',
    });

    if ((i + 1) % 200 === 0 || i + 1 === records.length) {
      console.log(`  Processed ${i + 1}/${records.length} crops... (Current Exact Acc: ${((exactCount / (i + 1)) * 100).toFixed(2)}%)`);
    }
  }

  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p95Latency = latencies[Math.floor(latencies.length * 0.95)];

  const summary = {
    model_label: modelLabel,
    total_evaluated: results.length,
    exact_matches: exactCount,
    exact_accuracy_percent: Number(((exactCount / results.length) * 100).toFixed(2)),
    normalized_matches: normCount,
    normalized_accuracy_percent: Number(((normCount / results.length) * 100).toFixed(2)),
    cer_percent: Number(((totalDist / totalGtLen) * 100).toFixed(2)),
    avg_latency_ms: Number(avgLatency.toFixed(2)),
    p95_latency_ms: Number(p95Latency.toFixed(2)),
  };

  return { summary, results };
}

function analyzeConfusion(baselineResults, finetunedResults) {
  const pairs = [
    ['O', '0'], ['0', 'O'],
    ['B', '8'], ['8', 'B'],
    ['S', '5'], ['5', 'S'],
    ['G', '6'], ['6', 'G'],
    ['I', '1'], ['1', 'I'],
    ['Z', '2'], ['2', 'Z'],
  ];

  const confusion = {};
  for (const [c1, c2] of pairs) {
    confusion[`${c1}_to_${c2}`] = { baseline: 0, finetuned: 0 };
  }

  let baseStateCorrect = 0;
  let fineStateCorrect = 0;
  let totalStateEvaluated = 0;

  let baseDigitsCorrect = 0;
  let fineDigitsCorrect = 0;
  let totalDigits = 0;

  let baseLettersCorrect = 0;
  let fineLettersCorrect = 0;
  let totalLetters = 0;

  for (let i = 0; i < baselineResults.length; i++) {
    const b = baselineResults[i];
    const f = finetunedResults[i];
    const gt = b.ground_truth;
    const bPred = b.prediction;
    const fPred = f.prediction;

    // State code check (first 2 chars)
    if (gt.length >= 2) {
      totalStateEvaluated++;
      if (bPred.slice(0, 2) === gt.slice(0, 2)) baseStateCorrect++;
      if (fPred.slice(0, 2) === gt.slice(0, 2)) fineStateCorrect++;
    }

    // Character level confusion
    const minLen = Math.min(gt.length, bPred.length);
    for (let j = 0; j < minLen; j++) {
      const key = `${gt[j]}_to_${bPred[j]}`;
      if (confusion[key]) confusion[key].baseline++;
      if (/\d/.test(gt[j])) {
        totalDigits++;
        if (bPred[j] === gt[j]) baseDigitsCorrect++;
      } else if (/[A-Z]/.test(gt[j])) {
        totalLetters++;
        if (bPred[j] === gt[j]) baseLettersCorrect++;
      }
    }

    const minLenF = Math.min(gt.length, fPred.length);
    for (let j = 0; j < minLenF; j++) {
      const key = `${gt[j]}_to_${fPred[j]}`;
      if (confusion[key]) confusion[key].finetuned++;
      if (/\d/.test(gt[j]) && fPred[j] === gt[j]) fineDigitsCorrect++;
      if (/[A-Z]/.test(gt[j]) && fPred[j] === gt[j]) fineLettersCorrect++;
    }
  }

  return {
    pairs: confusion,
    state_code: {
      total: totalStateEvaluated,
      baseline_accuracy: Number(((baseStateCorrect / totalStateEvaluated) * 100).toFixed(2)),
      finetuned_accuracy: Number(((fineStateCorrect / totalStateEvaluated) * 100).toFixed(2)),
    },
    digits: {
      total: totalDigits,
      baseline_accuracy: Number(((baseDigitsCorrect / totalDigits) * 100).toFixed(2)),
      finetuned_accuracy: Number(((fineDigitsCorrect / totalDigits) * 100).toFixed(2)),
    },
    letters: {
      total: totalLetters,
      baseline_accuracy: Number(((baseLettersCorrect / totalLetters) * 100).toFixed(2)),
      finetuned_accuracy: Number(((fineLettersCorrect / totalLetters) * 100).toFixed(2)),
    },
  };
}

function calculateBreakdowns(results) {
  const groups = {
    single_line: { total: 0, exact: 0 },
    two_line: { total: 0, exact: 0 },
    res_sub50: { total: 0, exact: 0 },
    res_50_100: { total: 0, exact: 0 },
    res_100_200: { total: 0, exact: 0 },
    res_over200: { total: 0, exact: 0 },
    src_google: { total: 0, exact: 0 },
    src_olx: { total: 0, exact: 0 },
    src_video: { total: 0, exact: 0 },
  };

  for (const r of results) {
    // Single / Two-line
    if (r.is_two_line) {
      groups.two_line.total++;
      if (r.is_exact) groups.two_line.exact++;
    } else {
      groups.single_line.total++;
      if (r.is_exact) groups.single_line.exact++;
    }

    // Resolution
    if (r.res_tier === '<50 px') {
      groups.res_sub50.total++;
      if (r.is_exact) groups.res_sub50.exact++;
    } else if (r.res_tier === '50–100 px') {
      groups.res_50_100.total++;
      if (r.is_exact) groups.res_50_100.exact++;
    } else if (r.res_tier === '100–200 px') {
      groups.res_100_200.total++;
      if (r.is_exact) groups.res_100_200.exact++;
    } else {
      groups.res_over200.total++;
      if (r.is_exact) groups.res_over200.exact++;
    }

    // Source
    if (r.source === 'google_images') {
      groups.src_google.total++;
      if (r.is_exact) groups.src_google.exact++;
    } else if (r.source === 'State-wise_OLX') {
      groups.src_olx.total++;
      if (r.is_exact) groups.src_olx.exact++;
    } else if (r.source === 'video_images') {
      groups.src_video.total++;
      if (r.is_exact) groups.src_video.exact++;
    }
  }

  const res = {};
  for (const [k, v] of Object.entries(groups)) {
    res[k] = {
      total: v.total,
      exact: v.exact,
      accuracy_percent: v.total > 0 ? Number(((v.exact / v.total) * 100).toFixed(2)) : 0,
    };
  }
  return res;
}

async function main() {
  console.log('Starting Feature 3B Real-World Benchmark Runner...');
  const records = parseCsv(GROUND_TRUTH_CSV);
  console.log(`Loaded ${records.length} ground truth records from ${GROUND_TRUTH_CSV}`);

  // 1. Run Baseline
  const baseline = await runEvaluation(BASELINE_MODEL_PATH, 'Baseline CCT-XS (Feature 1 + 2)', records);

  // 2. Run Fine-Tuned
  const finetuned = await runEvaluation(FINETUNED_MODEL_PATH, 'Indian Fine-Tuned CCT-XS (Feature 1 + 2)', records);

  // 3. Compare Transitions
  let wrongToCorrect = 0;
  let correctToWrong = 0;
  const changedPredictions = [];

  for (let i = 0; i < records.length; i++) {
    const b = baseline.results[i];
    const f = finetuned.results[i];

    if (b.prediction !== f.prediction) {
      const becameCorrect = !b.is_exact && f.is_exact;
      const becameWrong = b.is_exact && !f.is_exact;
      if (becameCorrect) wrongToCorrect++;
      if (becameWrong) correctToWrong++;

      changedPredictions.push({
        image_path: b.image_path,
        ground_truth: b.ground_truth,
        baseline_prediction: b.prediction,
        finetuned_prediction: f.prediction,
        transition: becameCorrect ? 'WRONG_TO_CORRECT' : (becameWrong ? 'CORRECT_TO_WRONG' : 'CHANGED_STILL_WRONG'),
        baseline_distance: b.edit_distance,
        finetuned_distance: f.edit_distance,
        res_tier: b.res_tier,
        is_two_line: b.is_two_line,
      });
    }
  }

  const netImprovement = wrongToCorrect - correctToWrong;
  const baselineBreakdown = calculateBreakdowns(baseline.results);
  const finetunedBreakdown = calculateBreakdowns(finetuned.results);
  const confusionAnalysis = analyzeConfusion(baseline.results, finetuned.results);

  // 4. Comparison Summary JSON
  const comparisonData = {
    timestamp: new Date().toISOString(),
    total_evaluated: records.length,
    baseline_summary: baseline.summary,
    finetuned_summary: finetuned.summary,
    transitions: {
      wrong_to_correct: wrongToCorrect,
      correct_to_wrong: correctToWrong,
      net_improvement: netImprovement,
      total_changed: changedPredictions.length,
    },
    breakdowns: {
      baseline: baselineBreakdown,
      finetuned: finetunedBreakdown,
    },
    confusion: confusionAnalysis,
  };

  const compJsonPath = path.join(BENCHMARK_DIR, 'benchmark_feature3b_after_comparison.json');
  fs.writeFileSync(compJsonPath, JSON.stringify(comparisonData, null, 2), 'utf-8');
  console.log(`Saved comparison JSON to ${compJsonPath}`);

  // 5. Changed Predictions CSV
  const changedCsvPath = path.join(BENCHMARK_DIR, 'benchmark_feature3b_changed_predictions.csv');
  const csvHeader = 'image_path,ground_truth,baseline_prediction,finetuned_prediction,transition,baseline_distance,finetuned_distance,res_tier,is_two_line\n';
  const csvRows = changedPredictions.map(p =>
    `"${p.image_path}","${p.ground_truth}","${p.baseline_prediction}","${p.finetuned_prediction}","${p.transition}",${p.baseline_distance},${p.finetuned_distance},"${p.res_tier}",${p.is_two_line}`
  ).join('\n');
  fs.writeFileSync(changedCsvPath, csvHeader + csvRows, 'utf-8');
  console.log(`Saved changed predictions to ${changedCsvPath}`);

  // 6. Detailed Results CSV
  const resultsCsvPath = path.join(BENCHMARK_DIR, 'benchmark_feature3b_after_results.csv');
  const resHeader = 'image_path,ground_truth,baseline_pred,finetuned_pred,baseline_exact,finetuned_exact,baseline_dist,finetuned_dist,res_tier,is_two_line,source\n';
  const resRows = records.map((_, i) => {
    const b = baseline.results[i];
    const f = finetuned.results[i];
    return `"${b.image_path}","${b.ground_truth}","${b.prediction}","${f.prediction}",${b.is_exact},${f.is_exact},${b.edit_distance},${f.edit_distance},"${b.res_tier}",${b.is_two_line},"${b.source}"`;
  }).join('\n');
  fs.writeFileSync(resultsCsvPath, resHeader + resRows, 'utf-8');
  console.log(`Saved detailed results to ${resultsCsvPath}`);

  // 7. Markdown Report
  const reportPath = path.join(BENCHMARK_DIR, 'benchmark_feature3b_after_report.md');
  const reportContent = `# VisionTrack Feature 3B: Fine-Tuned CCT-XS OCR Benchmark Report
**Dataset:** \`D:\\Download\\ANPR_BENCHMARK\` (1,696 untouched real-world Indian plate crops)
**Evaluated At:** ${new Date().toISOString()}
**Comparison:** Feature 1 + Feature 2 + Baseline CCT-XS vs. Feature 1 + Feature 2 + Indian-Fine-Tuned CCT-XS

---

## 1. Executive Performance Comparison

| Metric | Baseline (Feature 1 + 2) | Fine-Tuned (Feature 3B) | Delta |
| :--- | :---: | :---: | :---: |
| **Exact Matches** | ${baseline.summary.exact_matches} | **${finetuned.summary.exact_matches}** | **${finetuned.summary.exact_matches - baseline.summary.exact_matches >= 0 ? '+' : ''}${finetuned.summary.exact_matches - baseline.summary.exact_matches}** |
| **Exact Plate Accuracy %** | ${baseline.summary.exact_accuracy_percent}% | **${finetuned.summary.exact_accuracy_percent}%** | **${(finetuned.summary.exact_accuracy_percent - baseline.summary.exact_accuracy_percent).toFixed(2)} pp** |
| **Normalized Match Accuracy %** | ${baseline.summary.normalized_accuracy_percent}% | **${finetuned.summary.normalized_accuracy_percent}%** | **${(finetuned.summary.normalized_accuracy_percent - baseline.summary.normalized_accuracy_percent).toFixed(2)} pp** |
| **Average CER (Character Error Rate)** | ${baseline.summary.cer_percent}% | **${finetuned.summary.cer_percent}%** | **${(finetuned.summary.cer_percent - baseline.summary.cer_percent).toFixed(2)} pp** |
| **Average OCR Latency** | ${baseline.summary.avg_latency_ms} ms | **${finetuned.summary.avg_latency_ms} ms** | **${(finetuned.summary.avg_latency_ms - baseline.summary.avg_latency_ms).toFixed(2)} ms** |
| **P95 OCR Latency** | ${baseline.summary.p95_latency_ms} ms | **${finetuned.summary.p95_latency_ms} ms** | **${(finetuned.summary.p95_latency_ms - baseline.summary.p95_latency_ms).toFixed(2)} ms** |

---

## 2. Prediction Transition Dynamics

| Transition Category | Count | % of Dataset |
| :--- | :---: | :---: |
| **Total Changed Predictions** | **${changedPredictions.length}** | **${((changedPredictions.length / records.length) * 100).toFixed(2)}%** |
| **Wrong $\\rightarrow$ Correct (IMPROVED)** | **${wrongToCorrect}** | **+${((wrongToCorrect / records.length) * 100).toFixed(2)}%** |
| **Correct $\\rightarrow$ Wrong (REGRESSED)** | **${correctToWrong}** | **-${((correctToWrong / records.length) * 100).toFixed(2)}%** |
| **Net Accuracy Gain** | **${netImprovement >= 0 ? '+' : ''}${netImprovement} plates** | **${netImprovement >= 0 ? '+' : ''}${((netImprovement / records.length) * 100).toFixed(2)}%** |

---

## 3. Plate Layout & Resolution Breakdown

| Slice / Tier | Baseline Exact % | Fine-Tuned Exact % | Delta |
| :--- | :---: | :---: | :---: |
| **Single-Line Plates** (${baselineBreakdown.single_line.total}) | ${baselineBreakdown.single_line.accuracy_percent}% | **${finetunedBreakdown.single_line.accuracy_percent}%** | ${(finetunedBreakdown.single_line.accuracy_percent - baselineBreakdown.single_line.accuracy_percent).toFixed(2)} pp |
| **Two-Line Plates** (${baselineBreakdown.two_line.total}) | ${baselineBreakdown.two_line.accuracy_percent}% | **${finetunedBreakdown.two_line.accuracy_percent}%** | ${(finetunedBreakdown.two_line.accuracy_percent - baselineBreakdown.two_line.accuracy_percent).toFixed(2)} pp |
| **<50 px Width** (${baselineBreakdown.res_sub50.total}) | ${baselineBreakdown.res_sub50.accuracy_percent}% | **${finetunedBreakdown.res_sub50.accuracy_percent}%** | ${(finetunedBreakdown.res_sub50.accuracy_percent - baselineBreakdown.res_sub50.accuracy_percent).toFixed(2)} pp |
| **50–100 px Width** (${baselineBreakdown.res_50_100.total}) | ${baselineBreakdown.res_50_100.accuracy_percent}% | **${finetunedBreakdown.res_50_100.accuracy_percent}%** | ${(finetunedBreakdown.res_50_100.accuracy_percent - baselineBreakdown.res_50_100.accuracy_percent).toFixed(2)} pp |
| **100–200 px Width** (${baselineBreakdown.res_100_200.total}) | ${baselineBreakdown.res_100_200.accuracy_percent}% | **${finetunedBreakdown.res_100_200.accuracy_percent}%** | ${(finetunedBreakdown.res_100_200.accuracy_percent - baselineBreakdown.res_100_200.accuracy_percent).toFixed(2)} pp |
| **>200 px Width** (${baselineBreakdown.res_over200.total}) | ${baselineBreakdown.res_over200.accuracy_percent}% | **${finetunedBreakdown.res_over200.accuracy_percent}%** | ${(finetunedBreakdown.res_over200.accuracy_percent - baselineBreakdown.res_over200.accuracy_percent).toFixed(2)} pp |

---

## 4. Dataset Source Breakdown

| Source Folder | Total Samples | Baseline Exact % | Fine-Tuned Exact % | Delta |
| :--- | :---: | :---: | :---: | :---: |
| **google_images** | ${baselineBreakdown.src_google.total} | ${baselineBreakdown.src_google.accuracy_percent}% | **${finetunedBreakdown.src_google.accuracy_percent}%** | ${(finetunedBreakdown.src_google.accuracy_percent - baselineBreakdown.src_google.accuracy_percent).toFixed(2)} pp |
| **State-wise_OLX** | ${baselineBreakdown.src_olx.total} | ${baselineBreakdown.src_olx.accuracy_percent}% | **${finetunedBreakdown.src_olx.accuracy_percent}%** | ${(finetunedBreakdown.src_olx.accuracy_percent - baselineBreakdown.src_olx.accuracy_percent).toFixed(2)} pp |
| **video_images** | ${baselineBreakdown.src_video.total} | ${baselineBreakdown.src_video.accuracy_percent}% | **${finetunedBreakdown.src_video.accuracy_percent}%** | ${(finetunedBreakdown.src_video.accuracy_percent - baselineBreakdown.src_video.accuracy_percent).toFixed(2)} pp |

---

## 5. Indian Character Recognition Analysis

| Category | Baseline Accuracy % | Fine-Tuned Accuracy % | Delta |
| :--- | :---: | :---: | :---: |
| **State Code Recognition** | ${confusionAnalysis.state_code.baseline_accuracy}% | **${confusionAnalysis.state_code.finetuned_accuracy}%** | ${(confusionAnalysis.state_code.finetuned_accuracy - confusionAnalysis.state_code.baseline_accuracy).toFixed(2)} pp |
| **Digit Recognition** | ${confusionAnalysis.digits.baseline_accuracy}% | **${confusionAnalysis.digits.finetuned_accuracy}%** | ${(confusionAnalysis.digits.finetuned_accuracy - confusionAnalysis.digits.baseline_accuracy).toFixed(2)} pp |
| **Letter Recognition** | ${confusionAnalysis.letters.baseline_accuracy}% | **${confusionAnalysis.letters.finetuned_accuracy}%** | ${(confusionAnalysis.letters.finetuned_accuracy - confusionAnalysis.letters.baseline_accuracy).toFixed(2)} pp |

### Ambiguous Glyph Pair Confusions:
| Confused Pair | Baseline Errors | Fine-Tuned Errors | Delta |
| :--- | :---: | :---: | :---: |
| **O vs 0** | ${confusionAnalysis.pairs['O_to_0'].baseline + confusionAnalysis.pairs['0_to_O'].baseline} | ${confusionAnalysis.pairs['O_to_0'].finetuned + confusionAnalysis.pairs['0_to_O'].finetuned} | ${(confusionAnalysis.pairs['O_to_0'].finetuned + confusionAnalysis.pairs['0_to_O'].finetuned) - (confusionAnalysis.pairs['O_to_0'].baseline + confusionAnalysis.pairs['0_to_O'].baseline)} |
| **B vs 8** | ${confusionAnalysis.pairs['B_to_8'].baseline + confusionAnalysis.pairs['8_to_B'].baseline} | ${confusionAnalysis.pairs['B_to_8'].finetuned + confusionAnalysis.pairs['8_to_B'].finetuned} | ${(confusionAnalysis.pairs['B_to_8'].finetuned + confusionAnalysis.pairs['8_to_B'].finetuned) - (confusionAnalysis.pairs['B_to_8'].baseline + confusionAnalysis.pairs['8_to_B'].baseline)} |
| **S vs 5** | ${confusionAnalysis.pairs['S_to_5'].baseline + confusionAnalysis.pairs['5_to_S'].baseline} | ${confusionAnalysis.pairs['S_to_5'].finetuned + confusionAnalysis.pairs['5_to_S'].finetuned} | ${(confusionAnalysis.pairs['S_to_5'].finetuned + confusionAnalysis.pairs['5_to_S'].finetuned) - (confusionAnalysis.pairs['S_to_5'].baseline + confusionAnalysis.pairs['5_to_S'].baseline)} |
| **G vs 6** | ${confusionAnalysis.pairs['G_to_6'].baseline + confusionAnalysis.pairs['6_to_G'].baseline} | ${confusionAnalysis.pairs['G_to_6'].finetuned + confusionAnalysis.pairs['6_to_G'].finetuned} | ${(confusionAnalysis.pairs['G_to_6'].finetuned + confusionAnalysis.pairs['6_to_G'].finetuned) - (confusionAnalysis.pairs['G_to_6'].baseline + confusionAnalysis.pairs['6_to_G'].baseline)} |
| **I vs 1** | ${confusionAnalysis.pairs['I_to_1'].baseline + confusionAnalysis.pairs['1_to_I'].baseline} | ${confusionAnalysis.pairs['I_to_1'].finetuned + confusionAnalysis.pairs['1_to_I'].finetuned} | ${(confusionAnalysis.pairs['I_to_1'].finetuned + confusionAnalysis.pairs['1_to_I'].finetuned) - (confusionAnalysis.pairs['I_to_1'].baseline + confusionAnalysis.pairs['1_to_I'].baseline)} |
| **Z vs 2** | ${confusionAnalysis.pairs['Z_to_2'].baseline + confusionAnalysis.pairs['2_to_Z'].baseline} | ${confusionAnalysis.pairs['Z_to_2'].finetuned + confusionAnalysis.pairs['2_to_Z'].finetuned} | ${(confusionAnalysis.pairs['Z_to_2'].finetuned + confusionAnalysis.pairs['2_to_Z'].finetuned) - (confusionAnalysis.pairs['Z_to_2'].baseline + confusionAnalysis.pairs['2_to_Z'].baseline)} |
`;

  fs.writeFileSync(reportPath, reportContent, 'utf-8');
  console.log(`Saved benchmark report to ${reportPath}`);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});

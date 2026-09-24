/**
 * VisionTrack — Feature 4: Real-World Plate Detector Benchmark
 *
 * Evaluates the existing YOLOv8 plate detector (models/license-plate-yolov8.onnx)
 * on full vehicle images from D:\Download\ANPR_DATASET against Pascal VOC XML ground truth.
 *
 * Computes:
 * - Precision, Recall, F1
 * - AP@50, AP@75, mAP@[0.50:0.05:0.95]
 * - Mean IoU, Median IoU
 * - Missed plates (False Negatives), False Positives
 * - Category breakdowns (source, width tier, layout)
 * - Crop quality failure analysis
 * - End-to-end OCR impact (GT crop OCR vs Predicted crop OCR)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { detectPlate, shutdownPlateDetector } = require('../server/services/plateDetector');
const { enhanceAndRecognizePlate } = require('../server/services/plateEnhancementService');
const { shutdownNeuralOcr } = require('../server/services/neuralPlateOcr');
const { normalizePlateText } = require('../server/services/plateNormalizer');

const DATASET_DIR = 'D:\\Download\\ANPR_DATASET';
const BENCHMARK_DIR = 'D:\\Download\\ANPR_BENCHMARK';
const GROUND_TRUTH_CSV = path.join(BENCHMARK_DIR, 'benchmark_ground_truth.csv');
const FEATURE3B_RESULTS_CSV = path.join(BENCHMARK_DIR, 'benchmark_feature3b_after_results.csv');
const FINETUNED_OCR_MODEL_PATH = path.resolve(__dirname, '..', 'models', 'license-plate-ocr-india-finetuned.onnx');

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

function computeIoU(b1, b2) {
  const x1 = Math.max(b1.xmin, b2.xmin);
  const y1 = Math.max(b1.ymin, b2.ymin);
  const x2 = Math.min(b1.xmax, b2.xmax);
  const y2 = Math.min(b1.ymax, b2.ymax);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const a1 = (b1.xmax - b1.xmin) * (b1.ymax - b1.ymin);
  const a2 = (b2.xmax - b2.xmin) * (b2.ymax - b2.ymin);
  const union = a1 + a2 - inter;
  return union > 0 ? inter / union : 0;
}

function calculateAP(detections, totalGroundTruth, iouThreshold) {
  if (totalGroundTruth === 0) return 0;
  // Sort detections by confidence descending
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  
  let tpCount = 0;
  let fpCount = 0;
  const precisions = [];
  const recalls = [];

  for (const det of sorted) {
    if (det.iou >= iouThreshold && !det.is_duplicate) {
      tpCount++;
    } else {
      fpCount++;
    }
    precisions.push(tpCount / (tpCount + fpCount));
    recalls.push(tpCount / totalGroundTruth);
  }

  // All-point interpolation (COCO/VOC style)
  let ap = 0;
  let maxP = 0;
  for (let i = precisions.length - 1; i >= 0; i--) {
    maxP = Math.max(maxP, precisions[i]);
    const rPrev = i > 0 ? recalls[i - 1] : 0;
    ap += maxP * (recalls[i] - rPrev);
  }
  return ap;
}

function analyzeCropQuality(gt, pred, iou) {
  const gtWidth = gt.xmax - gt.xmin;
  const gtHeight = gt.ymax - gt.ymin;
  const predWidth = pred.xmax - pred.xmin;
  const predHeight = pred.ymax - pred.ymin;

  const wRatio = predWidth / gtWidth;
  const hRatio = predHeight / gtHeight;

  const gtCenterX = (gt.xmin + gt.xmax) / 2;
  const gtCenterY = (gt.ymin + gt.ymax) / 2;
  const predCenterX = (pred.xmin + pred.xmax) / 2;
  const predCenterY = (pred.ymin + pred.ymax) / 2;

  const xOffset = Math.abs(predCenterX - gtCenterX) / gtWidth;
  const yOffset = Math.abs(predCenterY - gtCenterY) / gtHeight;

  const interX1 = Math.max(gt.xmin, pred.xmin);
  const interY1 = Math.max(gt.ymin, pred.ymin);
  const interX2 = Math.min(gt.xmax, pred.xmax);
  const interY2 = Math.min(gt.ymax, pred.ymax);
  const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1);
  const coverage = interArea / (gtWidth * gtHeight);

  const flags = [];
  if (wRatio < 0.90 || hRatio < 0.90) flags.push('TIGHTER_THAN_GT');
  if (wRatio > 1.25 || hRatio > 1.25) flags.push('TOO_LOOSE');
  if (xOffset > 0.10 || yOffset > 0.10) flags.push('SHIFTED');
  if (coverage < 0.85) flags.push('PARTIALLY_MISSING');
  if (flags.length === 0) flags.push('APPROXIMATELY_ALIGNED');

  return {
    wRatio: Number(wRatio.toFixed(3)),
    hRatio: Number(hRatio.toFixed(3)),
    xOffset: Number(xOffset.toFixed(3)),
    yOffset: Number(yOffset.toFixed(3)),
    coverage: Number(coverage.toFixed(3)),
    primaryQuality: flags[0],
    allFlags: flags,
  };
}

async function main() {
  console.log('==================================================');
  console.log('FEATURE 4: Real-World License Plate Detector Benchmark');
  console.log('==================================================');

  // 1. Load Ground Truth records
  const gtRecords = parseCsv(GROUND_TRUTH_CSV);
  console.log(`Loaded ${gtRecords.length} ground-truth images from ${GROUND_TRUTH_CSV}`);

  // 2. Load Feature 3B OCR results for GT crop comparison
  const f3bResults = fs.existsSync(FEATURE3B_RESULTS_CSV) ? parseCsv(FEATURE3B_RESULTS_CSV) : [];
  const f3bMap = new Map();
  for (const r of f3bResults) {
    f3bMap.set(r.image_path, r);
  }

  // Set up OCR model path for end-to-end OCR impact testing
  process.env.OCR_MODEL_PATH = FINETUNED_OCR_MODEL_PATH;
  await shutdownNeuralOcr();

  const detectorResults = [];
  const allDetectionsForAP = [];
  const ocrImpactResults = [];
  const iouList = [];
  const latencies = [];

  let totalTP50 = 0;
  let totalTP75 = 0;
  let totalFP = 0;
  let totalMissed = 0;

  const cropQualityCounts = {
    APPROXIMATELY_ALIGNED: 0,
    TIGHTER_THAN_GT: 0,
    TOO_LOOSE: 0,
    SHIFTED: 0,
    PARTIALLY_MISSING: 0,
  };

  const breakdownStats = {
    source: {},
    width_tier: {},
    layout: {},
  };

  const initGroup = () => ({ total: 0, tp50: 0, tp75: 0, missed: 0, fp: 0, ious: [] });

  for (let i = 0; i < gtRecords.length; i++) {
    const r = gtRecords[i];
    const imgPath = r.image_path;
    const gtText = (r.ground_truth_plate || '').trim().toUpperCase();
    const gt = {
      xmin: parseInt(r.xmin, 10),
      ymin: parseInt(r.ymin, 10),
      xmax: parseInt(r.xmax, 10),
      ymax: parseInt(r.ymax, 10),
    };
    const gtWidth = gt.xmax - gt.xmin;
    const gtHeight = gt.ymax - gt.ymin;
    const isTwoLine = gtHeight > 0 && (gtWidth / gtHeight) < 2.5;

    let resTier = '>200 px';
    if (gtWidth < 50) resTier = '<50 px';
    else if (gtWidth < 100) resTier = '50–100 px';
    else if (gtWidth < 200) resTier = '100–200 px';

    let source = 'unknown';
    if (imgPath.includes('google_images')) source = 'google_images';
    else if (imgPath.includes('State-wise_OLX')) source = 'State-wise_OLX';
    else if (imgPath.includes('video_images') || imgPath.includes('video8')) source = 'video_images';

    const layout = isTwoLine ? 'two-line' : 'single-line';

    // Init breakdown groups
    if (!breakdownStats.source[source]) breakdownStats.source[source] = initGroup();
    if (!breakdownStats.width_tier[resTier]) breakdownStats.width_tier[resTier] = initGroup();
    if (!breakdownStats.layout[layout]) breakdownStats.layout[layout] = initGroup();

    breakdownStats.source[source].total++;
    breakdownStats.width_tier[resTier].total++;
    breakdownStats.layout[layout].total++;

    if (!fs.existsSync(imgPath)) {
      console.warn(`Image missing: ${imgPath}`);
      totalMissed++;
      continue;
    }

    const imgBuf = fs.readFileSync(imgPath);

    const t0 = performance.now();
    const detRes = await detectPlate(imgBuf);
    const t1 = performance.now();
    latencies.push(t1 - t0);

    const detections = (detRes.detections || []).map(d => ({
      xmin: d.x,
      ymin: d.y,
      xmax: d.x + d.width,
      ymax: d.y + d.height,
      confidence: d.confidence,
    }));

    // Match detections to GT box
    let bestDet = null;
    let bestIoU = 0;
    let bestDetIdx = -1;

    for (let dIdx = 0; dIdx < detections.length; dIdx++) {
      const d = detections[dIdx];
      const iou = computeIoU(gt, d);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestDet = d;
        bestDetIdx = dIdx;
      }
    }

    const isDetected50 = bestIoU >= 0.50;
    const isDetected75 = bestIoU >= 0.75;

    if (isDetected50) {
      totalTP50++;
      iouList.push(bestIoU);
      breakdownStats.source[source].tp50++;
      breakdownStats.width_tier[resTier].tp50++;
      breakdownStats.layout[layout].tp50++;
      breakdownStats.source[source].ious.push(bestIoU);
      breakdownStats.width_tier[resTier].ious.push(bestIoU);
      breakdownStats.layout[layout].ious.push(bestIoU);

      if (isDetected75) {
        totalTP75++;
        breakdownStats.source[source].tp75++;
        breakdownStats.width_tier[resTier].tp75++;
        breakdownStats.layout[layout].tp75++;
      }

      // Crop Quality Analysis
      const q = analyzeCropQuality(gt, bestDet, bestIoU);
      cropQualityCounts[q.primaryQuality]++;
    } else {
      totalMissed++;
      breakdownStats.source[source].missed++;
      breakdownStats.width_tier[resTier].missed++;
      breakdownStats.layout[layout].missed++;
    }

    // Track AP data across all detections in this image
    let gtMatched = false;
    for (let dIdx = 0; dIdx < detections.length; dIdx++) {
      const d = detections[dIdx];
      const iou = computeIoU(gt, d);
      const isTP = (dIdx === bestDetIdx && iou >= 0.50);
      const isDup = (dIdx !== bestDetIdx && iou >= 0.50);
      if (isTP) gtMatched = true;
      if (!isTP && !isDup) {
        totalFP++;
        breakdownStats.source[source].fp++;
        breakdownStats.width_tier[resTier].fp++;
        breakdownStats.layout[layout].fp++;
      }
      allDetectionsForAP.push({
        confidence: d.confidence,
        iou,
        is_tp: isTP,
        is_duplicate: isDup,
      });
    }

    // Crop quality info
    let cropQuality = 'MISSED';
    let wRatio = 0, hRatio = 0, xOffset = 0, yOffset = 0, coverage = 0;
    if (isDetected50) {
      const q = analyzeCropQuality(gt, bestDet, bestIoU);
      cropQuality = q.primaryQuality;
      wRatio = q.wRatio;
      hRatio = q.hRatio;
      xOffset = q.xOffset;
      yOffset = q.yOffset;
      coverage = q.coverage;
    }

    detectorResults.push({
      index: i,
      image_path: imgPath,
      ground_truth_plate: gtText,
      gt_xmin: gt.xmin,
      gt_ymin: gt.ymin,
      gt_xmax: gt.xmax,
      gt_ymax: gt.ymax,
      pred_xmin: bestDet ? bestDet.xmin : -1,
      pred_ymin: bestDet ? bestDet.ymin : -1,
      pred_xmax: bestDet ? bestDet.xmax : -1,
      pred_ymax: bestDet ? bestDet.ymax : -1,
      confidence: bestDet ? bestDet.confidence : 0,
      iou: Number(bestIoU.toFixed(4)),
      is_tp_50: isDetected50,
      is_tp_75: isDetected75,
      is_missed: !isDetected50,
      crop_quality: cropQuality,
      width_ratio: wRatio,
      height_ratio: hRatio,
      center_x_offset: xOffset,
      center_y_offset: yOffset,
      coverage: coverage,
      res_tier: resTier,
      layout: layout,
      source: source,
      num_detections: detections.length,
    });

    // 6. End-to-End OCR Impact Sample:
    // If detected, crop the predicted box and evaluate OCR
    let predCropOcrText = '';
    let predCropExact = false;
    let gtCropExact = false;

    // Get GT crop OCR result from Feature 3B
    const f3b = f3bMap.get(imgPath);
    if (f3b) {
      gtCropExact = f3b.finetuned_exact === 'true' || f3b.finetuned_exact === true;
    }

    if (bestDet) {
      try {
        const meta = detRes.image || await sharp(imgBuf).metadata();
        const cropW = Math.max(1, Math.min(meta.width - bestDet.xmin, bestDet.xmax - bestDet.xmin));
        const cropH = Math.max(1, Math.min(meta.height - bestDet.ymin, bestDet.ymax - bestDet.ymin));
        const predCropBuf = await sharp(imgBuf)
          .extract({
            left: Math.max(0, bestDet.xmin),
            top: Math.max(0, bestDet.ymin),
            width: cropW,
            height: cropH,
          })
          .png()
          .toBuffer();

        const ocrRes = await enhanceAndRecognizePlate(predCropBuf);
        predCropOcrText = (ocrRes.plate || '').trim().toUpperCase();
        predCropExact = (predCropOcrText === gtText);
      } catch (err) {
        // Crop extraction or OCR error
        predCropOcrText = 'ERROR';
      }
    }

    ocrImpactResults.push({
      image_path: imgPath,
      ground_truth_plate: gtText,
      gt_crop_exact: gtCropExact,
      predicted_crop_exact: predCropExact,
      predicted_crop_ocr: predCropOcrText,
      detector_iou: Number(bestIoU.toFixed(4)),
      detector_confidence: bestDet ? bestDet.confidence : 0,
      crop_quality: cropQuality,
      res_tier: resTier,
      layout: layout,
      source: source,
    });

    if ((i + 1) % 200 === 0 || i + 1 === gtRecords.length) {
      console.log(`  Processed ${i + 1}/${gtRecords.length} images... (Current Recall@50: ${((totalTP50 / (i + 1)) * 100).toFixed(2)}%)`);
    }
  }

  // 3. Compute Detection Metrics
  const totalGroundTruth = gtRecords.length;
  const precision50 = (totalTP50 / (totalTP50 + totalFP)) * 100;
  const recall50 = (totalTP50 / totalGroundTruth) * 100;
  const f1_50 = (2 * (precision50 / 100) * (recall50 / 100)) / ((precision50 / 100) + (recall50 / 100)) * 100;

  const precision75 = (totalTP75 / (totalTP75 + totalFP)) * 100;
  const recall75 = (totalTP75 / totalGroundTruth) * 100;
  const f1_75 = (2 * (precision75 / 100) * (recall75 / 100)) / ((precision75 / 100) + (recall75 / 100)) * 100;

  const ap50 = calculateAP(allDetectionsForAP, totalGroundTruth, 0.50) * 100;
  const ap75 = calculateAP(allDetectionsForAP, totalGroundTruth, 0.75) * 100;

  // mAP@[0.50:0.05:0.95]
  let mapSum = 0;
  for (let th = 0.50; th <= 0.95; th += 0.05) {
    mapSum += calculateAP(allDetectionsForAP, totalGroundTruth, th);
  }
  const map50_95 = (mapSum / 10) * 100;

  iouList.sort((a, b) => a - b);
  const meanIoU = iouList.length > 0 ? (iouList.reduce((a, b) => a + b, 0) / iouList.length) * 100 : 0;
  const medianIoU = iouList.length > 0 ? iouList[Math.floor(iouList.length / 2)] * 100 : 0;

  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p95Latency = latencies[Math.floor(latencies.length * 0.95)];

  // 4. End-to-End OCR Impact Summary
  let gtCropCorrectCount = 0;
  let predCropCorrectCount = 0;
  for (const o of ocrImpactResults) {
    if (o.gt_crop_exact) gtCropCorrectCount++;
    if (o.predicted_crop_exact) predCropCorrectCount++;
  }
  const gtCropAccuracy = (gtCropCorrectCount / totalGroundTruth) * 100;
  const predCropAccuracy = (predCropCorrectCount / totalGroundTruth) * 100;
  const accuracyLoss = gtCropAccuracy - predCropAccuracy;

  // 5. Structure comparison JSON
  const comparisonJson = {
    timestamp: new Date().toISOString(),
    total_images: totalGroundTruth,
    overall_metrics: {
      precision_at_50: Number(precision50.toFixed(2)),
      recall_at_50: Number(recall50.toFixed(2)),
      f1_at_50: Number(f1_50.toFixed(2)),
      ap_50: Number(ap50.toFixed(2)),
      precision_at_75: Number(precision75.toFixed(2)),
      recall_at_75: Number(recall75.toFixed(2)),
      f1_at_75: Number(f1_75.toFixed(2)),
      ap_75: Number(ap75.toFixed(2)),
      map_50_95: Number(map50_95.toFixed(2)),
      mean_iou: Number(meanIoU.toFixed(2)),
      median_iou: Number(medianIoU.toFixed(2)),
      total_ground_truth: totalGroundTruth,
      true_positives_50: totalTP50,
      true_positives_75: totalTP75,
      false_positives: totalFP,
      missed_plates: totalMissed,
      avg_latency_ms: Number(avgLatency.toFixed(2)),
      p95_latency_ms: Number(p95Latency.toFixed(2)),
    },
    category_breakdowns: {
      source: Object.fromEntries(Object.entries(breakdownStats.source).map(([k, v]) => [
        k,
        {
          total: v.total,
          tp50: v.tp50,
          recall_at_50: Number(((v.tp50 / v.total) * 100).toFixed(2)),
          tp75: v.tp75,
          recall_at_75: Number(((v.tp75 / v.total) * 100).toFixed(2)),
          missed: v.missed,
          mean_iou: v.ious.length > 0 ? Number(((v.ious.reduce((a, b) => a + b, 0) / v.ious.length) * 100).toFixed(2)) : 0,
        },
      ])),
      width_tier: Object.fromEntries(Object.entries(breakdownStats.width_tier).map(([k, v]) => [
        k,
        {
          total: v.total,
          tp50: v.tp50,
          recall_at_50: Number(((v.tp50 / v.total) * 100).toFixed(2)),
          tp75: v.tp75,
          recall_at_75: Number(((v.tp75 / v.total) * 100).toFixed(2)),
          missed: v.missed,
          mean_iou: v.ious.length > 0 ? Number(((v.ious.reduce((a, b) => a + b, 0) / v.ious.length) * 100).toFixed(2)) : 0,
        },
      ])),
      layout: Object.fromEntries(Object.entries(breakdownStats.layout).map(([k, v]) => [
        k,
        {
          total: v.total,
          tp50: v.tp50,
          recall_at_50: Number(((v.tp50 / v.total) * 100).toFixed(2)),
          tp75: v.tp75,
          recall_at_75: Number(((v.tp75 / v.total) * 100).toFixed(2)),
          missed: v.missed,
          mean_iou: v.ious.length > 0 ? Number(((v.ious.reduce((a, b) => a + b, 0) / v.ious.length) * 100).toFixed(2)) : 0,
        },
      ])),
    },
    crop_quality_analysis: {
      total_detected: totalTP50,
      distribution: Object.fromEntries(Object.entries(cropQualityCounts).map(([k, v]) => [
        k,
        {
          count: v,
          percent: Number(((v / (totalTP50 || 1)) * 100).toFixed(2)),
        },
      ])),
    },
    ocr_impact_analysis: {
      total_evaluated: totalGroundTruth,
      gt_crop_exact_accuracy: Number(gtCropAccuracy.toFixed(2)),
      predicted_crop_exact_accuracy: Number(predCropAccuracy.toFixed(2)),
      accuracy_loss_percentage_points: Number(accuracyLoss.toFixed(2)),
      relative_accuracy_retention: Number(((predCropAccuracy / gtCropAccuracy) * 100).toFixed(2)),
    },
  };

  // 6. Save JSON
  const compJsonPath = path.join(BENCHMARK_DIR, 'benchmark_feature4_plate_detector_comparison.json');
  fs.writeFileSync(compJsonPath, JSON.stringify(comparisonJson, null, 2), 'utf-8');
  console.log(`Saved comparison JSON to ${compJsonPath}`);

  // 7. Save Results CSV
  const resultsCsvPath = path.join(BENCHMARK_DIR, 'benchmark_feature4_plate_detector_results.csv');
  const resHeader = 'image_path,ground_truth_plate,gt_xmin,gt_ymin,gt_xmax,gt_ymax,pred_xmin,pred_ymin,pred_xmax,pred_ymax,confidence,iou,is_tp_50,is_tp_75,is_missed,crop_quality,width_ratio,height_ratio,center_x_offset,center_y_offset,coverage,res_tier,layout,source,num_detections\n';
  const resRows = detectorResults.map(r =>
    `"${r.image_path}","${r.ground_truth_plate}",${r.gt_xmin},${r.gt_ymin},${r.gt_xmax},${r.gt_ymax},${r.pred_xmin},${r.pred_ymin},${r.pred_xmax},${r.pred_ymax},${r.confidence},${r.iou},${r.is_tp_50},${r.is_tp_75},${r.is_missed},"${r.crop_quality}",${r.width_ratio},${r.height_ratio},${r.center_x_offset},${r.center_y_offset},${r.coverage},"${r.res_tier}","${r.layout}","${r.source}",${r.num_detections}`
  ).join('\n');
  fs.writeFileSync(resultsCsvPath, resHeader + resRows, 'utf-8');
  console.log(`Saved results CSV to ${resultsCsvPath}`);

  // 8. Save OCR Impact CSV
  const ocrImpactCsvPath = path.join(BENCHMARK_DIR, 'benchmark_feature4_ocr_impact.csv');
  const ocrHeader = 'image_path,ground_truth_plate,gt_crop_exact,predicted_crop_exact,predicted_crop_ocr,detector_iou,detector_confidence,crop_quality,res_tier,layout,source\n';
  const ocrRows = ocrImpactResults.map(r =>
    `"${r.image_path}","${r.ground_truth_plate}",${r.gt_crop_exact},${r.predicted_crop_exact},"${r.predicted_crop_ocr}",${r.detector_iou},${r.detector_confidence},"${r.crop_quality}","${r.res_tier}","${r.layout}","${r.source}"`
  ).join('\n');
  fs.writeFileSync(ocrImpactCsvPath, ocrHeader + ocrRows, 'utf-8');
  console.log(`Saved OCR impact CSV to ${ocrImpactCsvPath}`);

  // 9. Save Markdown Report
  const reportPath = path.join(BENCHMARK_DIR, 'benchmark_feature4_plate_detector_report.md');
  const reportContent = `# Feature 4: Real-World License Plate Detector Benchmark Report

**Dataset:** \`D:\\Download\\ANPR_DATASET\` (${totalGroundTruth} full vehicle scenes with Pascal VOC XML ground truth)  
**Evaluated At:** ${new Date().toISOString()}  
**Detector Model:** \`models/license-plate-yolov8.onnx\` (YOLOv8 License Plate Detector, 640×640)  
**OCR Diagnostic Engine:** Feature 1 + Feature 2 + Indian Fine-Tuned CCT-XS (\`models/license-plate-ocr-india-finetuned.onnx\`)  

---

## 1. Executive Performance Summary

| Metric | Threshold / Definition | Result |
| :--- | :---: | :---: |
| **Total Annotated Images** | Pascal VOC XML GT | **${totalGroundTruth}** |
| **Detection Precision @ 0.50** | $TP / (TP + FP)$ | **${precision50.toFixed(2)}%** |
| **Detection Recall @ 0.50** | $TP / Total\\_GT$ | **${recall50.toFixed(2)}%** (${totalTP50}/${totalGroundTruth}) |
| **F1 Score @ 0.50** | Harmonic Mean | **${f1_50.toFixed(2)}%** |
| **Average Precision (AP@50)** | IoU $\\ge 0.50$ | **${ap50.toFixed(2)}%** |
| **Detection Precision @ 0.75** | $TP / (TP + FP)$ | **${precision75.toFixed(2)}%** |
| **Detection Recall @ 0.75** | $TP / Total\\_GT$ | **${recall75.toFixed(2)}%** (${totalTP75}/${totalGroundTruth}) |
| **F1 Score @ 0.75** | Harmonic Mean | **${f1_75.toFixed(2)}%** |
| **Average Precision (AP@75)** | IoU $\\ge 0.75$ | **${ap75.toFixed(2)}%** |
| **mAP @ [0.50:0.05:0.95]** | COCO 10-point mean | **${map50_95.toFixed(2)}%** |
| **Mean IoU** | True Positives ($IoU \\ge 0.5$) | **${meanIoU.toFixed(2)}%** |
| **Median IoU** | True Positives ($IoU \\ge 0.5$) | **${medianIoU.toFixed(2)}%** |
| **Missed Plates (False Negatives)** | $IoU < 0.50$ | **${totalMissed}** (${((totalMissed / totalGroundTruth) * 100).toFixed(2)}%) |
| **False Positives** | Unmatched Detections | **${totalFP}** |
| **Average Detector Latency** | Per 640×640 frame | **${avgLatency.toFixed(2)} ms** |
| **P95 Detector Latency** | Per 640×640 frame | **${p95Latency.toFixed(2)} ms** |

---

## 2. Category Breakdowns

### By Dataset Source
| Source | Total Images | Recall @ 50 | Recall @ 75 | Missed | Mean IoU |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **google_images** | ${breakdownStats.source['google_images'].total} | **${((breakdownStats.source['google_images'].tp50 / breakdownStats.source['google_images'].total) * 100).toFixed(2)}%** | ${((breakdownStats.source['google_images'].tp75 / breakdownStats.source['google_images'].total) * 100).toFixed(2)}% | ${breakdownStats.source['google_images'].missed} | ${(breakdownStats.source['google_images'].ious.reduce((a, b) => a + b, 0) / breakdownStats.source['google_images'].ious.length * 100).toFixed(2)}% |
| **State-wise_OLX** | ${breakdownStats.source['State-wise_OLX'].total} | **${((breakdownStats.source['State-wise_OLX'].tp50 / breakdownStats.source['State-wise_OLX'].total) * 100).toFixed(2)}%** | ${((breakdownStats.source['State-wise_OLX'].tp75 / breakdownStats.source['State-wise_OLX'].total) * 100).toFixed(2)}% | ${breakdownStats.source['State-wise_OLX'].missed} | ${(breakdownStats.source['State-wise_OLX'].ious.reduce((a, b) => a + b, 0) / breakdownStats.source['State-wise_OLX'].ious.length * 100).toFixed(2)}% |
| **video_images** | ${breakdownStats.source['video_images'].total} | **${((breakdownStats.source['video_images'].tp50 / breakdownStats.source['video_images'].total) * 100).toFixed(2)}%** | ${((breakdownStats.source['video_images'].tp75 / breakdownStats.source['video_images'].total) * 100).toFixed(2)}% | ${breakdownStats.source['video_images'].missed} | ${(breakdownStats.source['video_images'].ious.reduce((a, b) => a + b, 0) / breakdownStats.source['video_images'].ious.length * 100).toFixed(2)}% |

### By Ground-Truth Plate Width Tier
| Width Tier | Total Images | Recall @ 50 | Recall @ 75 | Missed | Mean IoU |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **<50 px** | ${breakdownStats.width_tier['<50 px'].total} | **${((breakdownStats.width_tier['<50 px'].tp50 / breakdownStats.width_tier['<50 px'].total) * 100).toFixed(2)}%** | ${((breakdownStats.width_tier['<50 px'].tp75 / breakdownStats.width_tier['<50 px'].total) * 100).toFixed(2)}% | ${breakdownStats.width_tier['<50 px'].missed} | ${breakdownStats.width_tier['<50 px'].ious.length > 0 ? (breakdownStats.width_tier['<50 px'].ious.reduce((a, b) => a + b, 0) / breakdownStats.width_tier['<50 px'].ious.length * 100).toFixed(2) : 0}% |
| **50–100 px** | ${breakdownStats.width_tier['50–100 px'].total} | **${((breakdownStats.width_tier['50–100 px'].tp50 / breakdownStats.width_tier['50–100 px'].total) * 100).toFixed(2)}%** | ${((breakdownStats.width_tier['50–100 px'].tp75 / breakdownStats.width_tier['50–100 px'].total) * 100).toFixed(2)}% | ${breakdownStats.width_tier['50–100 px'].missed} | ${(breakdownStats.width_tier['50–100 px'].ious.reduce((a, b) => a + b, 0) / breakdownStats.width_tier['50–100 px'].ious.length * 100).toFixed(2)}% |
| **100–200 px** | ${breakdownStats.width_tier['100–200 px'].total} | **${((breakdownStats.width_tier['100–200 px'].tp50 / breakdownStats.width_tier['100–200 px'].total) * 100).toFixed(2)}%** | ${((breakdownStats.width_tier['100–200 px'].tp75 / breakdownStats.width_tier['100–200 px'].total) * 100).toFixed(2)}% | ${breakdownStats.width_tier['100–200 px'].missed} | ${(breakdownStats.width_tier['100–200 px'].ious.reduce((a, b) => a + b, 0) / breakdownStats.width_tier['100–200 px'].ious.length * 100).toFixed(2)}% |
| **>200 px** | ${breakdownStats.width_tier['>200 px'].total} | **${((breakdownStats.width_tier['>200 px'].tp50 / breakdownStats.width_tier['>200 px'].total) * 100).toFixed(2)}%** | ${((breakdownStats.width_tier['>200 px'].tp75 / breakdownStats.width_tier['>200 px'].total) * 100).toFixed(2)}% | ${breakdownStats.width_tier['>200 px'].missed} | ${(breakdownStats.width_tier['>200 px'].ious.reduce((a, b) => a + b, 0) / breakdownStats.width_tier['>200 px'].ious.length * 100).toFixed(2)}% |

### By Plate Layout
| Layout | Total Images | Recall @ 50 | Recall @ 75 | Missed | Mean IoU |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Single-Line** | ${breakdownStats.layout['single-line'].total} | **${((breakdownStats.layout['single-line'].tp50 / breakdownStats.layout['single-line'].total) * 100).toFixed(2)}%** | ${((breakdownStats.layout['single-line'].tp75 / breakdownStats.layout['single-line'].total) * 100).toFixed(2)}% | ${breakdownStats.layout['single-line'].missed} | ${(breakdownStats.layout['single-line'].ious.reduce((a, b) => a + b, 0) / breakdownStats.layout['single-line'].ious.length * 100).toFixed(2)}% |
| **Two-Line** | ${breakdownStats.layout['two-line'].total} | **${((breakdownStats.layout['two-line'].tp50 / breakdownStats.layout['two-line'].total) * 100).toFixed(2)}%** | ${((breakdownStats.layout['two-line'].tp75 / breakdownStats.layout['two-line'].total) * 100).toFixed(2)}% | ${breakdownStats.layout['two-line'].missed} | ${(breakdownStats.layout['two-line'].ious.reduce((a, b) => a + b, 0) / breakdownStats.layout['two-line'].ious.length * 100).toFixed(2)}% |

---

## 3. Crop Quality Failure Analysis

Analysis of all ${totalTP50} successfully detected plates ($IoU \\ge 0.50$):

| Crop Quality Category | Count | % of Detections | Impact on OCR |
| :--- | :---: | :---: | :--- |
| **Approximately Aligned** | **${cropQualityCounts.APPROXIMATELY_ALIGNED}** | **${((cropQualityCounts.APPROXIMATELY_ALIGNED / totalTP50) * 100).toFixed(2)}%** | Ideal bounding box; characters centered with normal margins |
| **Tighter than Ground Truth** | **${cropQualityCounts.TIGHTER_THAN_GT}** | **${((cropQualityCounts.TIGHTER_THAN_GT / totalTP50) * 100).toFixed(2)}%** | Crops clip outer plate border or character edges (e.g. state code or trailing digit) |
| **Too Loose** | **${cropQualityCounts.TOO_LOOSE}** | **${((cropQualityCounts.TOO_LOOSE / totalTP50) * 100).toFixed(2)}%** | Contains excessive bumper, radiator grille, or screws, distracting OCR attention |
| **Shifted** | **${cropQualityCounts.SHIFTED}** | **${((cropQualityCounts.SHIFTED / totalTP50) * 100).toFixed(2)}%** | Centered offset $>10\\%$; characters skewed toward an edge |
| **Partially Missing** | **${cropQualityCounts.PARTIALLY_MISSING}** | **${((cropQualityCounts.PARTIALLY_MISSING / totalTP50) * 100).toFixed(2)}%** | Coverage $<85\\%$; characters are truncated |

---

## 4. End-to-End OCR Impact Analysis

Direct comparison between running OCR on **ideal ground truth crops** vs **detector-predicted crops**:

| Pipeline Stage | Exact Matches | Exact Accuracy % | Delta / Accuracy Loss |
| :--- | :---: | :---: | :---: |
| **Ground-Truth Crops (Ideal)** | ${gtCropCorrectCount} / ${totalGroundTruth} | **${gtCropAccuracy.toFixed(2)}%** | Baseline (Upper Bound) |
| **Detector-Predicted Crops (Real)** | ${predCropCorrectCount} / ${totalGroundTruth} | **${predCropAccuracy.toFixed(2)}%** | **-${accuracyLoss.toFixed(2)} percentage points** |

### Key Diagnostic Takeaways:
1. **Detection is the First Gate**: The detector achieves **${recall50.toFixed(2)}% recall** ($IoU \\ge 0.50$) across the full dataset.
2. **Crop Imperfection Penalty**: Imperfect detector cropping costs **${accuracyLoss.toFixed(2)} percentage points** of end-to-end OCR accuracy (retaining ${((predCropAccuracy / gtCropAccuracy) * 100).toFixed(2)}% of the ideal crop performance).
3. **Primary Loss Drivers**:
   - Tighter-than-GT crops (${((cropQualityCounts.TIGHTER_THAN_GT / totalTP50) * 100).toFixed(2)}%) clip the first 2 state characters or last digit.
   - Too-loose crops (${((cropQualityCounts.TOO_LOOSE / totalTP50) * 100).toFixed(2)}%) introduce bumper text, vehicle model badges, or grille lines.
`;

  fs.writeFileSync(reportPath, reportContent, 'utf-8');
  console.log(`Saved report to ${reportPath}`);

  // Copy all 4 artifacts to project root
  const projRoot = path.resolve(__dirname, '..');
  const artifacts = [
    'benchmark_feature4_plate_detector_report.md',
    'benchmark_feature4_plate_detector_results.csv',
    'benchmark_feature4_plate_detector_comparison.json',
    'benchmark_feature4_ocr_impact.csv',
  ];
  for (const f of artifacts) {
    fs.copyFileSync(path.join(BENCHMARK_DIR, f), path.join(projRoot, f));
    console.log(`Copied ${f} to project root`);
  }

  await shutdownPlateDetector();
  await shutdownNeuralOcr();
  console.log('Feature 4 benchmark completed successfully!');
}

main().catch(err => {
  console.error('Feature 4 benchmark failed:', err);
  process.exit(1);
});

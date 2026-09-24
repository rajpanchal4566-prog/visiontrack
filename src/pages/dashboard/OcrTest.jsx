import { useState, useRef } from 'react';
import { Upload, Play, X, CheckCircle, XCircle, Clock, ScanLine, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../../services/config';
import './OcrTest.css';

export default function OcrTest() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  function handleFileSelect(e) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (!selected.type.startsWith('image/')) {
      setError('Please select an image file (JPEG, PNG, WebP, BMP).');
      return;
    }
    setFile(selected);
    setPreview(URL.createObjectURL(selected));
    setResult(null);
    setError(null);
  }

  function handleDrop(e) {
    e.preventDefault();
    const dropped = e.dataTransfer.files?.[0];
    if (!dropped || !dropped.type.startsWith('image/')) {
      setError('Please drop an image file.');
      return;
    }
    setFile(dropped);
    setPreview(URL.createObjectURL(dropped));
    setResult(null);
    setError(null);
  }

  function handleDragOver(e) {
    e.preventDefault();
  }

  function clearFile() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function runOcr() {
    if (!file) return;
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('image', file);

      const token = localStorage.getItem('anpr_token');
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(`${API_BASE}/ocr/test`, {
        method: 'POST',
        headers,
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.errorDetail || data.error || `Server error: ${response.status}`);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(`Request failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  function formatConfidence(value) {
    if (value === null || value === undefined) return '—';
    // Confidence from Tesseract is on 0-100 scale
    const pct = value > 1 ? value : value * 100;
    return `${pct.toFixed(1)}%`;
  }

  function formatTime(ms) {
    if (!ms && ms !== 0) return '—';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  return (
    <div className="ocr-test">
      {/* Upload area */}
      <div
        className={`ocr-test__upload-area ${file ? 'ocr-test__upload-area--has-image' : ''}`}
        onClick={() => fileInputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="ocr-test__file-input"
          onChange={handleFileSelect}
        />
        {!file ? (
          <>
            <Upload size={36} className="ocr-test__upload-icon" />
            <div className="ocr-test__upload-text">
              <strong>Click to upload</strong> or drag and drop a license plate image<br />
              JPEG, PNG, WebP, BMP — max 10MB
            </div>
          </>
        ) : (
          <div className="ocr-test__preview">
            <img src={preview} alt="Plate preview" className="ocr-test__preview-image" />
            <span className="ocr-test__preview-name">{file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="ocr-test__actions">
        <button
          className="ocr-test__btn ocr-test__btn--primary"
          onClick={runOcr}
          disabled={!file || loading}
        >
          {loading ? (
            <>
              <span className="ocr-test__spinner" />
              Processing...
            </>
          ) : (
            <>
              <ScanLine size={18} />
              Run OCR
            </>
          )}
        </button>
        {file && (
          <button className="ocr-test__btn ocr-test__btn--secondary" onClick={clearFile}>
            <X size={16} />
            Clear
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="ocr-test__error">
          <XCircle size={16} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: '0.4rem' }} />
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className={`ocr-test__result ${result.success ? 'ocr-test__result--success' : 'ocr-test__result--failure'}`}>
          <div className={`ocr-test__result-header ${result.success ? 'ocr-test__result-header--success' : 'ocr-test__result-header--failure'}`}>
            {result.success ? <CheckCircle size={20} /> : result.rawText ? <AlertTriangle size={20} /> : <XCircle size={20} />}
            {result.success ? 'OCR Successful' : result.ocrStatus || 'OCR Failed'}
          </div>

          <div className="ocr-test__result-grid">
            {/* Recognized Plate */}
            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">Recognized Plate</span>
              <span className={`ocr-test__result-value ${result.success ? 'ocr-test__result-value--plate' : 'ocr-test__result-value--muted'}`}>
                {result.plate || 'Not recognized'}
              </span>
            </div>

            {/* OCR Status */}
            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">OCR Status</span>
              <span className="ocr-test__result-value">
                {result.ocrStatus || '—'}
              </span>
            </div>

            {/* Confidence */}
            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">Confidence</span>
              <span className="ocr-test__result-value">
                {formatConfidence(result.confidence)}
              </span>
              {result.confidence > 0 && (
                <div className="ocr-test__confidence-bar">
                  <div
                    className="ocr-test__confidence-fill"
                    style={{ width: `${Math.min(100, result.confidence > 1 ? result.confidence : result.confidence * 100)}%` }}
                  />
                </div>
              )}
            </div>

            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">Detector Confidence</span>
              <span className="ocr-test__result-value">{formatConfidence(result.detectorConfidence)}</span>
            </div>

            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">OCR Confidence</span>
              <span className="ocr-test__result-value">{formatConfidence(result.ocrConfidence)}</span>
            </div>

            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">Final Confidence</span>
              <span className="ocr-test__result-value">{formatConfidence(result.finalConfidence)}</span>
            </div>

            {/* Processing Time */}
            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">Processing Time</span>
              <span className="ocr-test__result-value">
                <Clock size={14} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: '0.3rem', opacity: 0.5 }} />
                {formatTime(result.processingTime)}
              </span>
            </div>

            {/* Detected crop preview */}
            {result.plateCrop && (
              <div className="ocr-test__result-item ocr-test__crop-preview">
                <span className="ocr-test__result-label">Detected Plate Region</span>
                <img src={result.plateCrop} alt="Detected plate crop" />
                {result.plateRegion && (
                  <span className="ocr-test__result-value ocr-test__result-value--muted">
                    x:{result.plateRegion.x} y:{result.plateRegion.y} w:{result.plateRegion.width} h:{result.plateRegion.height}
                  </span>
                )}
              </div>
            )}

            {/* Raw OCR Text — ALWAYS show this */}
            <div className="ocr-test__result-item" style={{ gridColumn: '1 / -1' }}>
              <span className="ocr-test__result-label">Raw OCR Text</span>
              <span className="ocr-test__result-value ocr-test__result-value--muted" style={{ wordBreak: 'break-all' }}>
                {result.rawText ? `"${result.rawText}"` : '(empty)'}
              </span>
            </div>

            {/* Variant Used */}
            {result.variantUsed && (
              <div className="ocr-test__result-item">
                <span className="ocr-test__result-label">Preprocessing Variant</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  {result.variantUsed} (PSM: {result.psmUsed || '—'})
                </span>
              </div>
            )}

            {/* Corrections */}
            {result.corrections && result.corrections.length > 0 && (
              <div className="ocr-test__result-item">
                <span className="ocr-test__result-label">Corrections Applied</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  {result.corrections.join(', ')}
                </span>
              </div>
            )}

            {/* Image Info */}
            {result.preprocessingInfo && (
              <div className="ocr-test__result-item">
                <span className="ocr-test__result-label">Image Info</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  {result.preprocessingInfo.width}×{result.preprocessingInfo.height} {result.preprocessingInfo.format}
                  {result.preprocessingInfo.size ? ` (${(result.preprocessingInfo.size / 1024).toFixed(1)} KB)` : ''}
                </span>
              </div>
            )}

            {result.timings && (
              <div className="ocr-test__result-item" style={{ gridColumn: '1 / -1' }}>
                <span className="ocr-test__result-label">Pipeline Timings</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  Detection {formatTime(result.timings.detection)} · Preprocessing {formatTime(result.timings.preprocessing)} · OCR {formatTime(result.timings.ocr)} · Normalization {formatTime(result.timings.normalization)} · Total {formatTime(result.timings.total)}
                </span>
              </div>
            )}

            <div className="ocr-test__result-item">
              <span className="ocr-test__result-label">Plate Candidates</span>
              <span className="ocr-test__result-value">{result.candidateCount ?? '—'}</span>
            </div>

            {result.candidateRegions?.length > 0 && (
              <div className="ocr-test__result-item" style={{ gridColumn: '1 / -1' }}>
                <span className="ocr-test__result-label">Candidate Bounding Boxes</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  {result.candidateRegions.map((candidate, index) => (
                    <span key={index} style={{ display: 'block' }}>
                      #{index + 1}: x:{candidate.x} y:{candidate.y} w:{candidate.width} h:{candidate.height} · {candidate.source === 'direct_crop' ? 'direct crop' : `${formatConfidence(candidate.confidence * 100)}`}
                    </span>
                  ))}
                </span>
              </div>
            )}

            {result.candidates?.length > 0 && (
              <div className="ocr-test__result-item" style={{ gridColumn: '1 / -1' }}>
                <span className="ocr-test__result-label">OCR Candidates ({result.candidates.length})</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  {result.candidates.map((candidate, index) => (
                    <span key={index} style={{ display: 'block' }}>
                      {index + 1}. {candidate.rawText} · OCR {formatConfidence(candidate.confidence)} · {candidate.variant}/{candidate.psm}{candidate.plate ? ` · ${candidate.plate}` : ''}
                    </span>
                  ))}
                </span>
              </div>
            )}

            {result.candidateRegions?.length > 0 && (
              <div className="ocr-test__result-item" style={{ gridColumn: '1 / -1' }}>
                <span className="ocr-test__result-label">Candidate Bounding Boxes</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  {result.candidateRegions.map((candidate, index) => (
                    <span key={index} style={{ display: 'block' }}>
                      #{index + 1}: x:{candidate.x} y:{candidate.y} w:{candidate.width} h:{candidate.height} · {candidate.source === 'direct_crop' ? 'direct crop' : `${formatConfidence(candidate.confidence * 100)}`}
                    </span>
                  ))}
                </span>
              </div>
            )}

            {/* Error Detail */}
            {result.errorDetail && (
              <div className="ocr-test__result-item" style={{ gridColumn: '1 / -1' }}>
                <span className="ocr-test__result-label">Diagnostic</span>
                <span className="ocr-test__result-value ocr-test__result-value--muted">
                  {result.errorDetail}
                </span>
              </div>
            )}

            {/* All variant results */}
            {result.allResults && result.allResults.length > 1 && (
              <div className="ocr-test__result-item" style={{ gridColumn: '1 / -1' }}>
                <span className="ocr-test__result-label">All Variant Results ({result.allResults.length})</span>
                <div style={{ marginTop: '0.3rem' }}>
                  {result.allResults.map((r, i) => (
                    <div key={i} className="ocr-test__result-value ocr-test__result-value--muted" style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>
                      [{r.variant}/{r.psm}] "{r.text}" — {r.confidence}%
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Info box */}
      <div className="ocr-test__info">
        <strong>OCR Engine:</strong> Tesseract.js v7 (local processing, no cloud API)<br />
        <strong>Pipeline:</strong> Sharp candidate detection → crop → upscale/preprocess → Tesseract single-line OCR<br />
        <strong>Attempts:</strong> Up to 5 candidate regions × 3 preprocessing variants<br />
        <strong>Note:</strong> Results require both an Indian registration format and reasonable OCR confidence.
      </div>
    </div>
  );
}

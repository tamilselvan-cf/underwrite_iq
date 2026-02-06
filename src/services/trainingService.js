const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { generateId } = require('../utils/helpers');

// Database file path
const DB_PATH = process.env.TRAINING_DB_PATH || path.join(__dirname, '../../data/training.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS training_forms (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_path TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS training_images (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    image_data TEXT NOT NULL,
    mime_type TEXT DEFAULT 'image/png',
    FOREIGN KEY (form_id) REFERENCES training_forms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS training_extractions (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL UNIQUE,
    ai_extraction TEXT,
    corrected_extraction TEXT,
    is_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (form_id) REFERENCES training_forms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_forms_status ON training_forms(status);
  CREATE INDEX IF NOT EXISTS idx_images_form ON training_images(form_id);
`);

/**
 * Create a new training form entry
 */
function createForm(filename, images, aiExtraction) {
  const formId = generateId('form');

  const insertForm = db.prepare(`
    INSERT INTO training_forms (id, filename, status)
    VALUES (?, ?, 'pending')
  `);

  const insertImage = db.prepare(`
    INSERT INTO training_images (id, form_id, page_number, image_data, mime_type)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertExtraction = db.prepare(`
    INSERT INTO training_extractions (id, form_id, ai_extraction)
    VALUES (?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    insertForm.run(formId, filename);

    images.forEach((img, index) => {
      insertImage.run(
        generateId('img'),
        formId,
        img.page || index + 1,
        img.base64,
        img.mimeType || 'image/png'
      );
    });

    insertExtraction.run(
      generateId('ext'),
      formId,
      JSON.stringify(aiExtraction)
    );
  });

  transaction();
  return formId;
}

/**
 * Get all training forms with their status
 */
function getAllForms() {
  const stmt = db.prepare(`
    SELECT
      f.id,
      f.filename,
      f.status,
      f.created_at,
      f.updated_at,
      e.is_verified,
      (SELECT COUNT(*) FROM training_images WHERE form_id = f.id) as page_count
    FROM training_forms f
    LEFT JOIN training_extractions e ON e.form_id = f.id
    ORDER BY f.created_at DESC
  `);
  return stmt.all();
}

/**
 * Get a single form with images and extraction
 */
function getFormById(formId) {
  const formStmt = db.prepare(`
    SELECT * FROM training_forms WHERE id = ?
  `);
  const form = formStmt.get(formId);

  if (!form) return null;

  const imagesStmt = db.prepare(`
    SELECT * FROM training_images WHERE form_id = ? ORDER BY page_number
  `);
  const images = imagesStmt.all(formId);

  const extractionStmt = db.prepare(`
    SELECT * FROM training_extractions WHERE form_id = ?
  `);
  const extraction = extractionStmt.get(formId);

  return {
    ...form,
    images: images.map(img => ({
      id: img.id,
      page: img.page_number,
      base64: img.image_data,
      mimeType: img.mime_type
    })),
    aiExtraction: extraction?.ai_extraction ? JSON.parse(extraction.ai_extraction) : null,
    correctedExtraction: extraction?.corrected_extraction ? JSON.parse(extraction.corrected_extraction) : null,
    isVerified: extraction?.is_verified === 1
  };
}

/**
 * Update the corrected extraction for a form
 */
function updateExtraction(formId, correctedExtraction, isVerified = false) {
  const stmt = db.prepare(`
    UPDATE training_extractions
    SET corrected_extraction = ?, is_verified = ?, updated_at = CURRENT_TIMESTAMP
    WHERE form_id = ?
  `);

  const updateForm = db.prepare(`
    UPDATE training_forms
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const transaction = db.transaction(() => {
    stmt.run(JSON.stringify(correctedExtraction), isVerified ? 1 : 0, formId);
    updateForm.run(isVerified ? 'verified' : 'in_progress', formId);
  });

  transaction();
}

/**
 * Delete a training form
 */
function deleteForm(formId) {
  const stmt = db.prepare('DELETE FROM training_forms WHERE id = ?');
  stmt.run(formId);
}

/**
 * Get all verified forms for export
 */
function getVerifiedForms() {
  const stmt = db.prepare(`
    SELECT
      f.id,
      f.filename,
      e.corrected_extraction
    FROM training_forms f
    JOIN training_extractions e ON e.form_id = f.id
    WHERE e.is_verified = 1 AND e.corrected_extraction IS NOT NULL
  `);
  return stmt.all();
}

/**
 * Export training data in OpenAI fine-tuning format (JSONL)
 */
function exportToJsonl(systemPrompt) {
  const forms = getVerifiedForms();
  const lines = [];

  for (const form of forms) {
    const imagesStmt = db.prepare(`
      SELECT image_data, mime_type FROM training_images
      WHERE form_id = ? ORDER BY page_number
    `);
    const images = imagesStmt.all(form.id);

    // Create the training example in OpenAI format
    const example = {
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this form and extract its complete structure."
            },
            ...images.map(img => ({
              type: "image_url",
              image_url: {
                url: `data:${img.mime_type};base64,${img.image_data}`
              }
            }))
          ]
        },
        {
          role: "assistant",
          content: form.corrected_extraction
        }
      ]
    };

    lines.push(JSON.stringify(example));
  }

  return lines.join('\n');
}

/**
 * Get training statistics
 */
function getStats() {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) as verified
    FROM training_forms
  `).get();

  return stats;
}

module.exports = {
  createForm,
  getAllForms,
  getFormById,
  updateExtraction,
  deleteForm,
  getVerifiedForms,
  exportToJsonl,
  getStats
};

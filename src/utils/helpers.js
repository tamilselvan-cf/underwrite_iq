const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Generate a unique ID with optional prefix
 */
function generateId(prefix = '') {
  const shortId = uuidv4().split('-')[0];
  return prefix ? `${prefix}_${shortId}` : shortId;
}

/**
 * Get file extension from filename
 */
function getFileExtension(filename) {
  return path.extname(filename).toLowerCase().slice(1);
}

/**
 * Check if file type is supported
 */
function isSupportedFileType(filename) {
  const supportedTypes = ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png'];
  const ext = getFileExtension(filename);
  return supportedTypes.includes(ext);
}

/**
 * Get MIME type from extension
 */
function getMimeType(extension) {
  const mimeTypes = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png'
  };
  return mimeTypes[extension] || 'application/octet-stream';
}

/**
 * Clean up temporary files
 */
async function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.warn(`Failed to cleanup file: ${filePath}`, error.message);
    }
  }
}

/**
 * Ensure directory exists
 */
async function ensureDirectory(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Convert file to base64
 */
async function fileToBase64(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return fileBuffer.toString('base64');
}

/**
 * Parse JSON safely
 */
function safeJsonParse(str) {
  try {
    return { success: true, data: JSON.parse(str) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Extract JSON from text that might contain markdown code blocks
 */
function extractJsonFromText(text) {
  // Try to find JSON in markdown code blocks
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }

  // Try to find JSON object directly
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    return jsonObjectMatch[0];
  }

  return text;
}

module.exports = {
  generateId,
  getFileExtension,
  isSupportedFileType,
  getMimeType,
  cleanupFiles,
  ensureDirectory,
  fileToBase64,
  safeJsonParse,
  extractJsonFromText
};

const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { getFileExtension, fileToBase64, ensureDirectory, cleanupFiles } = require('../utils/helpers');
const { convertPdfToImages } = require('./pdfConverter');
const { convertDocxToImages } = require('./docxConverter');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const TEMP_DIR = path.join(__dirname, '../../uploads/temp');

/**
 * Process uploaded file and convert to images
 * @param {Object} file - Multer file object
 * @returns {Promise<Array<{page: number, base64: string, mimeType: string}>>}
 */
async function processFile(file) {
  const extension = getFileExtension(file.originalname);
  const sessionId = uuidv4();
  const tempDir = path.join(TEMP_DIR, sessionId);

  await ensureDirectory(tempDir);

  const filesToCleanup = [];

  try {
    let images = [];

    switch (extension) {
      case 'pdf':
        images = await convertPdfToImages(file.path, tempDir);
        break;

      case 'docx':
      case 'doc':
        images = await convertDocxToImages(file.path, tempDir);
        break;

      case 'jpg':
      case 'jpeg':
      case 'png':
        images = await processImage(file.path, tempDir);
        break;

      default:
        throw new Error(`Unsupported file type: ${extension}`);
    }

    // Track files for cleanup
    images.forEach(img => {
      if (img.path) filesToCleanup.push(img.path);
    });
    filesToCleanup.push(file.path);

    // Return images without file paths (for security)
    return images.map(img => ({
      page: img.page,
      base64: img.base64,
      mimeType: img.mimeType
    }));
  } finally {
    // Cleanup temporary files
    await cleanupFiles(filesToCleanup);

    // Try to remove temp directory
    try {
      await fs.rmdir(tempDir);
    } catch (e) {
      // Directory might not be empty or already removed
    }
  }
}

/**
 * Process image file (JPG/PNG)
 * @param {string} imagePath - Path to the image file
 * @param {string} outputDir - Output directory
 * @returns {Promise<Array<{page: number, base64: string, path: string, mimeType: string}>>}
 */
async function processImage(imagePath, outputDir) {
  const extension = getFileExtension(imagePath);
  const baseName = path.basename(imagePath, path.extname(imagePath));

  // Optimize image for AI processing
  const outputPath = path.join(outputDir, `${baseName}_processed.png`);

  await sharp(imagePath)
    .png({ quality: 90 })
    .resize({
      width: 2000,
      height: 2000,
      fit: 'inside',
      withoutEnlargement: true
    })
    .toFile(outputPath);

  const base64 = await fileToBase64(outputPath);

  return [{
    page: 1,
    base64,
    path: outputPath,
    mimeType: 'image/png'
  }];
}

/**
 * Get file type category
 * @param {string} filename - Original filename
 * @returns {string} File type category
 */
function getFileType(filename) {
  const extension = getFileExtension(filename);

  const typeMap = {
    pdf: 'pdf',
    docx: 'document',
    doc: 'document',
    jpg: 'image',
    jpeg: 'image',
    png: 'image'
  };

  return typeMap[extension] || 'unknown';
}

module.exports = {
  processFile,
  processImage,
  getFileType,
  UPLOADS_DIR,
  TEMP_DIR
};

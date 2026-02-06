const path = require('path');
const fs = require('fs').promises;
const { ensureDirectory, fileToBase64 } = require('../utils/helpers');

let pdfPoppler;
try {
  pdfPoppler = require('pdf-poppler');
} catch (error) {
  console.warn('pdf-poppler not available, PDF conversion may not work');
}

/**
 * Convert PDF to images using pdf-poppler
 * @param {string} pdfPath - Path to the PDF file
 * @param {string} outputDir - Directory to save images
 * @returns {Promise<Array<{page: number, base64: string, path: string}>>}
 */
async function convertPdfToImages(pdfPath, outputDir) {
  await ensureDirectory(outputDir);

  const baseName = path.basename(pdfPath, '.pdf');
  const outputPrefix = path.join(outputDir, baseName);

  const options = {
    format: 'png',
    out_dir: outputDir,
    out_prefix: baseName,
    page: null // Convert all pages
  };

  try {
    await pdfPoppler.convert(pdfPath, options);

    // Find all generated images
    const files = await fs.readdir(outputDir);
    const imageFiles = files
      .filter(f => f.startsWith(baseName) && f.endsWith('.png'))
      .sort((a, b) => {
        // Sort by page number
        const numA = parseInt(a.match(/-(\d+)\.png$/)?.[1] || '0');
        const numB = parseInt(b.match(/-(\d+)\.png$/)?.[1] || '0');
        return numA - numB;
      });

    const images = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const imagePath = path.join(outputDir, imageFiles[i]);
      const base64 = await fileToBase64(imagePath);
      images.push({
        page: i + 1,
        base64,
        path: imagePath,
        mimeType: 'image/png'
      });
    }

    return images;
  } catch (error) {
    throw new Error(`Failed to convert PDF: ${error.message}`);
  }
}

/**
 * Get PDF page count
 * @param {string} pdfPath - Path to the PDF file
 * @returns {Promise<number>}
 */
async function getPdfPageCount(pdfPath) {
  try {
    const info = await pdfPoppler.info(pdfPath);
    return info.pages || 1;
  } catch (error) {
    console.warn('Could not get PDF page count:', error.message);
    return 1;
  }
}

module.exports = {
  convertPdfToImages,
  getPdfPageCount
};

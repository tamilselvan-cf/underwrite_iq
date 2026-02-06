const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { processFile, UPLOADS_DIR } = require('../services/fileProcessor');
const { extractFormStructure } = require('../services/openaiService');
const { isSupportedFileType, ensureDirectory } = require('../utils/helpers');

const router = express.Router();

// Configure multer storage
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await ensureDirectory(UPLOADS_DIR);
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

// File filter
const fileFilter = (req, file, cb) => {
  if (isSupportedFileType(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
};

// Configure multer
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 // 10MB default
  }
});

/**
 * POST /api/extract-form
 * Extract form structure from uploaded document
 * Accepts field names: 'file', 'document', 'pdf', 'image'
 */
router.post('/extract-form', (req, res, next) => {
  // Handle multiple possible field names
  const uploadHandler = upload.any();

  uploadHandler(req, res, (err) => {
    if (err) {
      return next(err);
    }

    // Get the first uploaded file regardless of field name
    req.file = req.files && req.files[0];
    handleFormExtraction(req, res, next);
  });
});

async function handleFormExtraction(req, res, next) {
  const startTime = Date.now();

  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload a PDF, DOCX, JPG, or PNG file.'
      });
    }

    console.log(`Processing file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Process file and convert to images
    const images = await processFile(req.file);

    console.log(`Converted to ${images.length} image(s), sending to GPT-4o...`);

    // Extract form structure using GPT-4o
    const formStructure = await extractFormStructure(images);

    const processingTime = Date.now() - startTime;
    console.log(`Form extraction completed in ${processingTime}ms`);

    // Return successful response
    res.json({
      success: true,
      data: formStructure,
      meta: {
        originalFilename: req.file.originalname,
        fileSize: req.file.size,
        pagesProcessed: images.length,
        processingTimeMs: processingTime
      }
    });
  } catch (error) {
    console.error('Form extraction error:', error);
    next(error);
  }
}

/**
 * GET /api/supported-types
 * Get list of supported file types
 */
router.get('/supported-types', (req, res) => {
  res.json({
    success: true,
    data: {
      supportedTypes: ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png'],
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024,
      components: [
        'Signature',
        'Multi-Select',
        'File Upload',
        'Short Input',
        'Sections',
        'Dropdown',
        'Radio Select',
        'Table',
        'Title',
        'Long Input'
      ]
    }
  });
});

/**
 * GET /api/components
 * Get list of available form components
 */
router.get('/components', (req, res) => {
  res.json({
    success: true,
    data: [
      {
        name: 'Signature',
        description: 'Signature lines, boxes, or areas for signatures'
      },
      {
        name: 'Multi-Select',
        description: 'Checkboxes allowing multiple selections',
        hasOptions: true
      },
      {
        name: 'File Upload',
        description: 'Areas for file attachments or document uploads'
      },
      {
        name: 'Short Input',
        description: 'Single-line text input fields'
      },
      {
        name: 'Sections',
        description: 'Section dividers and headers'
      },
      {
        name: 'Dropdown',
        description: 'Select/dropdown fields',
        hasOptions: true
      },
      {
        name: 'Radio Select',
        description: 'Radio buttons for single selection',
        hasOptions: true
      },
      {
        name: 'Table',
        description: 'Tabular structures with columns and row count',
        hasColumns: true,
        hasRowCount: true
      },
      {
        name: 'Title',
        description: 'Form titles and major headings'
      },
      {
        name: 'Long Input',
        description: 'Multi-line text areas and comment boxes'
      }
    ]
  });
});

module.exports = router;

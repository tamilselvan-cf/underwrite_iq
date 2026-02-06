const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const { processFile, UPLOADS_DIR } = require('../services/fileProcessor');
const { extractFormStructure } = require('../services/openaiService');
const trainingService = require('../services/trainingService');
const { isSupportedFileType, ensureDirectory } = require('../utils/helpers');

// Initialize OpenAI client for fine-tuning
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024
  }
});

/**
 * GET /api/training/stats
 * Get training data statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = trainingService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/training/forms
 * Get all training forms
 */
router.get('/forms', (req, res) => {
  try {
    const forms = trainingService.getAllForms();
    res.json({ success: true, data: forms });
  } catch (error) {
    console.error('Error getting forms:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/training/forms/:id
 * Get a specific training form with images and extractions
 */
router.get('/forms/:id', (req, res) => {
  try {
    const form = trainingService.getFormById(req.params.id);
    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }
    res.json({ success: true, data: form });
  } catch (error) {
    console.error('Error getting form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/training/upload
 * Upload a form for training data creation
 */
router.post('/upload', (req, res, next) => {
  const uploadHandler = upload.any();

  uploadHandler(req, res, async (err) => {
    if (err) {
      return next(err);
    }

    req.file = req.files && req.files[0];

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      console.log(`[Training] Processing file: ${req.file.originalname}`);

      // Process file and convert to images
      const images = await processFile(req.file);

      console.log(`[Training] Converted to ${images.length} image(s), extracting with AI...`);

      // Extract form structure using GPT-4o
      const aiExtraction = await extractFormStructure(images);

      // Store in database
      const formId = trainingService.createForm(
        req.file.originalname,
        images,
        aiExtraction
      );

      console.log(`[Training] Form saved with ID: ${formId}`);

      res.json({
        success: true,
        data: {
          formId,
          filename: req.file.originalname,
          pageCount: images.length,
          aiExtraction
        }
      });
    } catch (error) {
      console.error('[Training] Upload error:', error);
      next(error);
    }
  });
});

/**
 * PUT /api/training/forms/:id
 * Update the corrected extraction for a form
 */
router.put('/forms/:id', (req, res) => {
  try {
    const { correctedExtraction, isVerified } = req.body;

    if (!correctedExtraction) {
      return res.status(400).json({
        success: false,
        error: 'correctedExtraction is required'
      });
    }

    const form = trainingService.getFormById(req.params.id);
    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    trainingService.updateExtraction(req.params.id, correctedExtraction, isVerified);

    res.json({
      success: true,
      message: isVerified ? 'Form verified and saved' : 'Form updated'
    });
  } catch (error) {
    console.error('Error updating form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/training/forms/:id
 * Delete a training form
 */
router.delete('/forms/:id', (req, res) => {
  try {
    const form = trainingService.getFormById(req.params.id);
    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    trainingService.deleteForm(req.params.id);
    res.json({ success: true, message: 'Form deleted' });
  } catch (error) {
    console.error('Error deleting form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/training/export
 * Export verified training data as JSONL for OpenAI fine-tuning
 */
router.post('/export', (req, res) => {
  try {
    const { systemPrompt } = req.body;

    if (!systemPrompt) {
      return res.status(400).json({
        success: false,
        error: 'systemPrompt is required'
      });
    }

    const jsonlData = trainingService.exportToJsonl(systemPrompt);
    const verifiedCount = trainingService.getStats().verified;

    if (verifiedCount === 0) {
      return res.status(400).json({
        success: false,
        error: 'No verified forms available for export'
      });
    }

    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', 'attachment; filename=training_data.jsonl');
    res.send(jsonlData);
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/training/export/preview
 * Preview export data without downloading
 */
router.get('/export/preview', (req, res) => {
  try {
    const stats = trainingService.getStats();
    const verifiedForms = trainingService.getVerifiedForms();

    res.json({
      success: true,
      data: {
        stats,
        verifiedForms: verifiedForms.map(f => ({
          id: f.id,
          filename: f.filename
        }))
      }
    });
  } catch (error) {
    console.error('Error previewing export:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/training/fine-tune
 * Start a fine-tuning job on OpenAI
 */
router.post('/fine-tune', async (req, res) => {
  try {
    const { systemPrompt, model = 'gpt-4o-2024-08-06', suffix } = req.body;

    if (!systemPrompt) {
      return res.status(400).json({
        success: false,
        error: 'systemPrompt is required'
      });
    }

    const verifiedCount = trainingService.getStats().verified;
    if (verifiedCount < 10) {
      return res.status(400).json({
        success: false,
        error: `Need at least 10 verified forms for fine-tuning. Currently have ${verifiedCount}.`
      });
    }

    console.log('[Fine-tuning] Exporting training data...');
    const jsonlData = trainingService.exportToJsonl(systemPrompt);

    // Save to temp file
    const tempFilePath = path.join(UPLOADS_DIR, `training_${Date.now()}.jsonl`);
    await ensureDirectory(UPLOADS_DIR);
    fs.writeFileSync(tempFilePath, jsonlData);

    console.log('[Fine-tuning] Uploading training file to OpenAI...');
    const file = await openai.files.create({
      file: fs.createReadStream(tempFilePath),
      purpose: 'fine-tune'
    });

    console.log(`[Fine-tuning] File uploaded: ${file.id}`);

    // Clean up temp file
    fs.unlinkSync(tempFilePath);

    console.log('[Fine-tuning] Creating fine-tuning job...');
    const fineTune = await openai.fineTuning.jobs.create({
      training_file: file.id,
      model: model,
      suffix: suffix || 'form-extractor'
    });

    console.log(`[Fine-tuning] Job created: ${fineTune.id}`);

    res.json({
      success: true,
      data: {
        jobId: fineTune.id,
        fileId: file.id,
        model: model,
        status: fineTune.status,
        trainingExamples: verifiedCount
      }
    });
  } catch (error) {
    console.error('[Fine-tuning] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/training/fine-tune/:jobId
 * Get status of a fine-tuning job
 */
router.get('/fine-tune/:jobId', async (req, res) => {
  try {
    const job = await openai.fineTuning.jobs.retrieve(req.params.jobId);

    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        model: job.model,
        fineTunedModel: job.fine_tuned_model,
        createdAt: job.created_at,
        finishedAt: job.finished_at,
        trainedTokens: job.trained_tokens,
        error: job.error
      }
    });
  } catch (error) {
    console.error('[Fine-tuning] Error getting job status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/training/fine-tune
 * List all fine-tuning jobs
 */
router.get('/fine-tune', async (req, res) => {
  try {
    const jobs = await openai.fineTuning.jobs.list({ limit: 20 });

    res.json({
      success: true,
      data: jobs.data.map(job => ({
        jobId: job.id,
        status: job.status,
        model: job.model,
        fineTunedModel: job.fine_tuned_model,
        createdAt: job.created_at
      }))
    });
  } catch (error) {
    console.error('[Fine-tuning] Error listing jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;

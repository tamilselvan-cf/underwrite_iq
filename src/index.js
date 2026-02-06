require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const formExtractorRoutes = require('./routes/formExtractor');
const trainingRoutes = require('./routes/training');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files for labeling UI
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api', formExtractorRoutes);
app.use('/api/training', trainingRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File size exceeds the maximum allowed limit'
    });
  }

  if (err.message === 'Invalid file type') {
    return res.status(400).json({
      success: false,
      error: 'Invalid file type. Allowed types: PDF, DOCX, JPG, PNG'
    });
  }

  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.listen(PORT, () => {
  console.log(`Form Extractor API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Extract form: POST http://localhost:${PORT}/api/extract-form`);
  console.log(`Training UI: http://localhost:${PORT}/labeling.html`);
});

module.exports = app;

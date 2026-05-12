const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '24h';

// Demo users (in production, use database)
const users = {
  'admin@finspark.io': {
    id: 'user_1',
    username: 'admin@finspark.io',
    passwordHash: crypto.createHash('sha256').update('admin123').digest('hex'),
    role: 'admin',
    tenantId: 'bank-alpha',
    name: 'Admin User'
  },
  'analyst@finspark.io': {
    id: 'user_2',
    username: 'analyst@finspark.io',
    passwordHash: crypto.createHash('sha256').update('analyst123').digest('hex'),
    role: 'analyst',
    tenantId: 'bank-alpha',
    name: 'Data Analyst'
  },
  'viewer@finspark.io': {
    id: 'user_3',
    username: 'viewer@finspark.io',
    passwordHash: crypto.createHash('sha256').update('viewer123').digest('hex'),
    role: 'viewer',
    tenantId: 'bank-beta',
    name: 'View Only User'
  }
};

// Middleware
app.use(cors({
  origin: [
    'https://oorjatiwari23.github.io',
    'http://localhost:5173',
    'http://localhost:3000',
    ],
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database(':memory:'); // In-memory for demo, use file for persistence

// Initialize database schema
db.serialize(() => {
  // Events table
  db.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      feature_name TEXT,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      deployment_mode TEXT NOT NULL,
      user_id TEXT,
      metadata TEXT,
      journey_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Aggregated metrics table (for on-prem mode)
  db.run(`
    CREATE TABLE aggregated_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      deployment_mode TEXT NOT NULL,
      feature_name TEXT NOT NULL,
      invocation_count INTEGER DEFAULT 0,
      unique_sessions INTEGER DEFAULT 0,
      unique_users INTEGER DEFAULT 0,
      avg_duration REAL DEFAULT 0,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Feature configuration table
  db.run(`
    CREATE TABLE feature_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      feature_name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT 1,
      licensed BOOLEAN DEFAULT 1,
      version TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, feature_name)
    )
  `);

  // Compliance audit log
  db.run(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      user_role TEXT,
      timestamp INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('Database initialized');
});

// ============================================================
// AUTHENTICATION ENDPOINTS
// ============================================================

/**
 * Login endpoint
 */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ 
      error: 'Missing credentials',
      message: 'Username and password are required'
    });
  }
  
  const user = users[username];
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  
  if (!user || passwordHash !== user.passwordHash) {
    return res.status(401).json({ 
      error: 'Invalid credentials',
      message: 'Incorrect username or password'
    });
  }
  
  const token = jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  
  console.log(`✓ User logged in: ${user.username} (${user.role})`);
  
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId
    },
    expiresIn: JWT_EXPIRES_IN
  });
});

/**
 * Get current user info
 */
app.get('/api/auth/me', authenticate, (req, res) => {
  const user = users[req.user.username];
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId
  });
});

/**
 * Logout endpoint
 */
app.post('/api/auth/logout', authenticate, (req, res) => {
  console.log(`✓ User logged out: ${req.user.username}`);
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

/**
 * Change password endpoint
 */
app.post('/api/auth/change-password', authenticate, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = users[req.user.username];
  const currentHash = crypto.createHash('sha256').update(currentPassword).digest('hex');
  
  if (!user || currentHash !== user.passwordHash) {
    return res.status(401).json({ error: 'Invalid current password' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  user.passwordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  
  res.json({
    success: true,
    message: 'Password changed successfully'
  });
});

/**
 * Authentication middleware
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Authentication required',
      message: 'Please provide a valid authentication token'
    });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ 
      error: 'Invalid or expired token',
      message: 'Please login again'
    });
  }
}

// ============================================================
// ON-PREM SYNC ENDPOINT
// ============================================================

/**
 * On-Prem Sync Endpoint
 * Receives aggregated, anonymized data from On-Prem installations
 */
app.post('/api/sync/onprem', (req, res) => {
  const { syncBatchId, tenantId, metrics, encrypted, data, iv, checksum } = req.body;

  console.log(`📥 Received On-Prem sync from ${tenantId}`);
  console.log(`   Batch: ${syncBatchId}`);
  console.log(`   Metrics: ${metrics ? metrics.length : 'encrypted'}`);

  // Decrypt if needed
  let metricsData = metrics;
  if (encrypted && data) {
    try {
      metricsData = decryptData(data, iv);
    } catch (error) {
      console.error('❌ Decryption failed:', error);
      return res.status(400).json({ error: 'Decryption failed' });
    }
  }

  if (!metricsData || !Array.isArray(metricsData)) {
    return res.status(400).json({ error: 'Invalid metrics data' });
  }

  // Verify checksum (optional but recommended)
  if (checksum && generateChecksum(metricsData) !== checksum) {
    console.warn('⚠️  Checksum mismatch - data may be corrupted');
  }

  // Store aggregated metrics
  const stmt = db.prepare(`
    INSERT INTO aggregated_metrics (
      tenant_id, deployment_mode, feature_name, invocation_count,
      unique_sessions, unique_users, period_start, period_end
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let stored = 0;
  let errors = 0;
  
  metricsData.forEach(metric => {
    stmt.run(
      tenantId,
      'onprem',
      metric.featureName,
      metric.invocationCount,
      metric.uniqueSessions,
      metric.uniqueUsers,
      metric.periodStart,
      metric.periodEnd,
      (err) => {
        if (err) {
          console.error('Error storing metric:', err);
          errors++;
        } else {
          stored++;
        }
        
        if (stored + errors === metricsData.length) {
          console.log(`   ✓ Stored ${stored}/${metricsData.length} metrics from On-Prem`);
          res.json({ 
            success: true, 
            syncBatchId,
            received: stored,
            failed: errors
          });
        }
      }
    );
  });

  stmt.finalize();
});

// Helper functions for sync
function decryptData(encryptedData, ivHex) {
  const key = process.env.ENCRYPTION_KEY || 'fallback-key-32-bytes-long-xxx';
  const iv = Buffer.from(ivHex, 'hex');
  const keyBuffer = Buffer.from(key.substring(0, 32).padEnd(32, '0'));
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv);
  
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return JSON.parse(decrypted);
}

function generateChecksum(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// ============================================================
// EVENT COLLECTION
// ============================================================

/**
 * Event Collection Endpoint
 * Handles both cloud and on-prem deployments differently
 */
app.post('/api/events', (req, res) => {
  const { events, deploymentMode, tenantId, batchMetadata } = req.body;

  if (!events || !Array.isArray(events)) {
    return res.status(400).json({ error: 'Invalid events payload' });
  }

  console.log(`Received ${events.length} events from ${tenantId} (${deploymentMode} mode)`);

  if (deploymentMode === 'cloud') {
    // Cloud mode: Store raw events
    handleCloudEvents(events, tenantId, (err) => {
      if (err) {
        console.error('Error storing cloud events:', err);
        return res.status(500).json({ error: 'Failed to store events' });
      }
      res.json({ 
        success: true, 
        stored: events.length,
        mode: 'cloud'
      });
    });
  } else if (deploymentMode === 'onprem') {
    // On-prem mode: Aggregate locally, store summaries
    handleOnPremEvents(events, tenantId, (err, aggregated) => {
      if (err) {
        console.error('Error aggregating on-prem events:', err);
        return res.status(500).json({ error: 'Failed to aggregate events' });
      }
      res.json({ 
        success: true, 
        aggregated: aggregated,
        mode: 'onprem'
      });
    });
  } else {
    res.status(400).json({ error: 'Invalid deployment mode' });
  }
});

/**
 * Handle cloud deployment events - store raw data
 */
function handleCloudEvents(events, tenantId, callback) {
  const stmt = db.prepare(`
    INSERT INTO events (
      event_type, feature_name, timestamp, session_id, tenant_id,
      deployment_mode, user_id, metadata, journey_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let completed = 0;
  let hasError = false;

  events.forEach(event => {
    stmt.run(
      event.eventType,
      event.featureName || null,
      event.timestamp,
      event.sessionId,
      event.tenantId || tenantId,
      'cloud',
      event.userId || null,
      JSON.stringify(event.metadata || {}),
      JSON.stringify(event.journey || event.journeyPath || []),
      (err) => {
        if (err && !hasError) {
          hasError = true;
          callback(err);
        }
        completed++;
        if (completed === events.length && !hasError) {
          callback(null);
        }
      }
    );
  });

  stmt.finalize();
}

/**
 * Handle on-prem deployment events - aggregate and anonymize
 */
function handleOnPremEvents(events, tenantId, callback) {
  // Group events by feature
  const featureGroups = {};
  
  events.forEach(event => {
    if (event.eventType === 'feature_invocation') {
      const key = event.featureName;
      if (!featureGroups[key]) {
        featureGroups[key] = {
          feature: key,
          count: 0,
          sessions: new Set(),
          users: new Set(),
          timestamps: []
        };
      }
      featureGroups[key].count++;
      featureGroups[key].sessions.add(event.sessionId);
      if (event.userId) featureGroups[key].users.add(event.userId);
      featureGroups[key].timestamps.push(event.timestamp);
    }
  });

  // Store aggregated metrics
  const stmt = db.prepare(`
    INSERT INTO aggregated_metrics (
      tenant_id, deployment_mode, feature_name, invocation_count,
      unique_sessions, unique_users, period_start, period_end
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  const periodStart = now - (5 * 60 * 1000); // 5 minutes window
  let aggregatedCount = 0;

  Object.values(featureGroups).forEach(group => {
    stmt.run(
      tenantId,
      'onprem',
      group.feature,
      group.count,
      group.sessions.size,
      group.users.size,
      periodStart,
      now,
      (err) => {
        if (err) console.error('Error storing aggregated metric:', err);
        aggregatedCount++;
        if (aggregatedCount === Object.keys(featureGroups).length) {
          callback(null, aggregatedCount);
        }
      }
    );
  });

  stmt.finalize();
}

// ============================================================
// ANALYTICS ENDPOINTS
// ============================================================

// Get feature usage heatmap
app.get('/api/analytics/heatmap', (req, res) => {
  const { tenantId, days = 7 } = req.query;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  db.all(`
    SELECT 
      feature_name,
      COUNT(*) as invocation_count,
      COUNT(DISTINCT session_id) as unique_sessions,
      COUNT(DISTINCT user_id) as unique_users,
      deployment_mode
    FROM events
    WHERE timestamp > ? 
      ${tenantId ? 'AND tenant_id = ?' : ''}
      AND event_type = 'feature_invocation'
    GROUP BY feature_name, deployment_mode
    ORDER BY invocation_count DESC
  `, tenantId ? [cutoff, tenantId] : [cutoff], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ data: rows });
  });
});

// Get journey funnel analytics
app.get('/api/analytics/funnel', (req, res) => {
  const { tenantId, journey } = req.query;
  
  if (!journey) {
    return res.status(400).json({ error: 'Journey parameter required' });
  }

  const journeySteps = journey.split(',');
  
  db.all(`
    SELECT journey_path, session_id, timestamp
    FROM events
    WHERE event_type = 'feature_invocation'
      ${tenantId ? 'AND tenant_id = ?' : ''}
    ORDER BY session_id, timestamp
  `, tenantId ? [tenantId] : [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Analyze funnel completion
    const funnelData = analyzeFunnel(rows, journeySteps);
    res.json({ data: funnelData });
  });
});

function analyzeFunnel(events, steps) {
  const sessionJourneys = {};
  
  events.forEach(event => {
    const journeyPath = JSON.parse(event.journey_path || '[]');
    if (!sessionJourneys[event.session_id]) {
      sessionJourneys[event.session_id] = [];
    }
    sessionJourneys[event.session_id].push(...journeyPath.map(j => j.step || j));
  });

  const funnelResults = steps.map((step, index) => {
    let reached = 0;
    let completed = 0;

    Object.values(sessionJourneys).forEach(journey => {
      const stepIndex = journey.indexOf(step);
      if (stepIndex !== -1) {
        reached++;
        if (index === steps.length - 1 || journey.includes(steps[index + 1])) {
          completed++;
        }
      }
    });

    return {
      step,
      reached,
      dropoff: reached - completed,
      conversionRate: reached > 0 ? (completed / reached * 100).toFixed(2) : 0
    };
  });

  return funnelResults;
}

// Get tenant comparison
app.get('/api/analytics/tenant-comparison', (req, res) => {
  const { days = 7 } = req.query;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  db.all(`
    SELECT 
      tenant_id,
      COUNT(*) as total_events,
      COUNT(DISTINCT feature_name) as features_used,
      COUNT(DISTINCT session_id) as total_sessions,
      COUNT(DISTINCT user_id) as total_users,
      deployment_mode
    FROM events
    WHERE timestamp > ?
    GROUP BY tenant_id, deployment_mode
  `, [cutoff], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ data: rows });
  });
});

// Get ROI metrics (license vs usage)
app.get('/api/analytics/roi', (req, res) => {
  const { tenantId } = req.query;

  db.all(`
    SELECT 
      fc.feature_name,
      fc.enabled,
      fc.licensed,
      COUNT(e.id) as usage_count,
      CASE 
        WHEN fc.licensed = 1 AND COUNT(e.id) = 0 THEN 'unused_licensed'
        WHEN fc.licensed = 1 AND COUNT(e.id) > 0 THEN 'active'
        WHEN fc.licensed = 0 THEN 'unlicensed'
        ELSE 'unknown'
      END as status
    FROM feature_configs fc
    LEFT JOIN events e ON fc.feature_name = e.feature_name 
      AND fc.tenant_id = e.tenant_id
      AND e.event_type = 'feature_invocation'
    WHERE fc.tenant_id = ?
    GROUP BY fc.feature_name, fc.enabled, fc.licensed
  `, [tenantId || 'demo-tenant'], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ data: rows });
  });
});

// Get real-time event stream (for demo purposes)
app.get('/api/analytics/stream', (req, res) => {
  const { limit = 50 } = req.query;

  db.all(`
    SELECT *
    FROM events
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ events: rows });
  });
});

// ============================================================
// COMPLIANCE & CONFIGURATION ENDPOINTS
// ============================================================

// Update telemetry settings
app.post('/api/compliance/settings', (req, res) => {
  const { tenantId, enabled, privacyLevel, userRole } = req.body;

  // Log audit trail
  db.run(`
    INSERT INTO audit_log (tenant_id, action, details, user_role, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `, [
    tenantId,
    enabled ? 'enable_telemetry' : 'disable_telemetry',
    JSON.stringify({ privacyLevel }),
    userRole || 'admin',
    Date.now()
  ], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to update settings' });
    }
    res.json({ success: true, tenantId, enabled, privacyLevel });
  });
});

// Get audit log
app.get('/api/compliance/audit-log', (req, res) => {
  const { tenantId, limit = 100 } = req.query;

  db.all(`
    SELECT * FROM audit_log
    WHERE tenant_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `, [tenantId || 'demo-tenant', limit], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ logs: rows });
  });
});

// Register feature configuration
app.post('/api/features/config', (req, res) => {
  const { tenantId, features } = req.body;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO feature_configs 
    (tenant_id, feature_name, enabled, licensed, version)
    VALUES (?, ?, ?, ?, ?)
  `);

  features.forEach(f => {
    stmt.run(tenantId, f.name, f.enabled, f.licensed, f.version);
  });

  stmt.finalize((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to update configuration' });
    }
    res.json({ success: true, configured: features.length });
  });
});

// ============================================================
// HEALTH & DEMO ENDPOINTS
// ============================================================

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    version: '2.0.0',
    features: {
      authentication: true,
      onpremSync: true,
      analytics: true,
      compliance: true
    }
  });
});

/**
 * Demo data seeding endpoint
 */
app.post('/api/demo/seed', (req, res) => {
  seedDemoData();
  res.json({ success: true, message: 'Demo data seeded' });
});

function seedDemoData() {
  const tenants = ['bank-alpha', 'bank-beta', 'bank-gamma'];
  const features = [
    'loan-application', 'credit-check', 'document-upload', 
    'loan-approval', 'disbursement', 'repayment-schedule',
    'customer-profile', 'risk-assessment', 'collateral-evaluation',
    'payment-processing'
  ];

  // Seed feature configs
  const configStmt = db.prepare(`
    INSERT OR REPLACE INTO feature_configs 
    (tenant_id, feature_name, enabled, licensed)
    VALUES (?, ?, ?, ?)
  `);

  tenants.forEach(tenant => {
    features.forEach(feature => {
      configStmt.run(
        tenant,
        feature,
        Math.random() > 0.1 ? 1 : 0, // 90% enabled
        Math.random() > 0.2 ? 1 : 0  // 80% licensed
      );
    });
  });

  configStmt.finalize();
  console.log('Demo data seeded');
}

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 FinSpark Feature Intelligence Server v2.0`);
  console.log(`   Port: ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api`);
  console.log(`   ✓ Authentication enabled`);
  console.log(`   ✓ On-Prem sync enabled`);
  console.log(`   ✓ Analytics ready`);
  console.log(`   ✓ Compliance ready\n`);
  seedDemoData();
});

module.exports = app;

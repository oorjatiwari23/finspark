/**
 * FinSpark Feature Intelligence SDK
 * Lightweight event tracking for enterprise applications
 */

class FeatureTracker {
  constructor(config = {}) {
    this.config = {
      endpoint: config.endpoint || 'http://localhost:3000/api/events',
      tenantId: config.tenantId || 'demo-tenant',
      deploymentMode: config.deploymentMode || 'cloud', // 'cloud' or 'onprem'
      enabled: config.enabled !== false,
      privacyLevel: config.privacyLevel || 'standard', // 'strict', 'standard', 'relaxed'
      batchSize: config.batchSize || 10,
      flushInterval: config.flushInterval || 5000, // 5 seconds
      autoCapture: config.autoCapture !== false,
      sessionId: this.generateSessionId(),
      ...config
    };

    this.eventQueue = [];
    this.sessionData = {
      startTime: Date.now(),
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };

    this.journeyStack = []; // Track user journey

    if (this.config.enabled) {
      this.initialize();
    }
  }

  initialize() {
    console.log(`[FeatureTracker] Initialized in ${this.config.deploymentMode} mode`);
    
    if (this.config.autoCapture) {
      this.setupAutoCapture();
    }

    // Start flush interval
    this.flushIntervalId = setInterval(() => this.flush(), this.config.flushInterval);

    // Flush on page unload
    window.addEventListener('beforeunload', () => this.flush(true));
  }

  /**
   * Track a feature invocation
   */
  trackFeature(featureName, metadata = {}) {
    if (!this.config.enabled) return;

    const event = {
      eventType: 'feature_invocation',
      featureName,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      tenantId: this.config.tenantId,
      deploymentMode: this.config.deploymentMode,
      userId: this.maskPII(metadata.userId),
      metadata: this.sanitizeMetadata(metadata),
      journey: [...this.journeyStack], // Current journey path
      context: {
        url: window.location.href,
        referrer: document.referrer,
        viewport: this.sessionData.viewport
      }
    };

    this.addToJourney(featureName);
    this.enqueueEvent(event);
  }

  /**
   * Track a journey step
   */
  trackJourney(stepName, stepData = {}) {
    if (!this.config.enabled) return;

    const event = {
      eventType: 'journey_step',
      stepName,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      tenantId: this.config.tenantId,
      stepData: this.sanitizeMetadata(stepData),
      journeyPath: [...this.journeyStack]
    };

    this.addToJourney(stepName);
    this.enqueueEvent(event);
  }

  /**
   * Track a feature dropoff
   */
  trackDropoff(featureName, reason = '') {
    if (!this.config.enabled) return;

    const event = {
      eventType: 'feature_dropoff',
      featureName,
      reason,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      tenantId: this.config.tenantId,
      journeyPath: [...this.journeyStack]
    };

    this.enqueueEvent(event);
  }

  /**
   * Track feature configuration (which features are enabled/licensed)
   */
  trackConfiguration(features = []) {
    if (!this.config.enabled) return;

    const event = {
      eventType: 'feature_configuration',
      features: features.map(f => ({
        name: f.name,
        enabled: f.enabled,
        licensed: f.licensed,
        version: f.version
      })),
      timestamp: Date.now(),
      tenantId: this.config.tenantId
    };

    this.enqueueEvent(event);
  }

  /**
   * Setup automatic click and interaction tracking
   */
  setupAutoCapture() {
    // Track clicks on elements with data-feature attribute
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-feature]');
      if (target) {
        const featureName = target.getAttribute('data-feature');
        const featureCategory = target.getAttribute('data-feature-category') || 'uncategorized';
        
        this.trackFeature(featureName, {
          category: featureCategory,
          elementType: target.tagName.toLowerCase(),
          elementId: target.id,
          elementText: target.textContent.slice(0, 50)
        });
      }
    }, true);

    // Track form submissions
    document.addEventListener('submit', (e) => {
      const form = e.target;
      const featureName = form.getAttribute('data-feature') || 'form_submission';
      
      this.trackFeature(featureName, {
        formId: form.id,
        formAction: form.action,
        fieldCount: form.elements.length
      });
    }, true);
  }

  /**
   * Add to journey tracking stack
   */
  addToJourney(stepName) {
    this.journeyStack.push({
      step: stepName,
      timestamp: Date.now()
    });

    // Keep only last 20 steps
    if (this.journeyStack.length > 20) {
      this.journeyStack.shift();
    }
  }

  /**
   * Enqueue event for batching
   */
  enqueueEvent(event) {
    this.eventQueue.push(event);

    // Flush if batch size reached
    if (this.eventQueue.length >= this.config.batchSize) {
      this.flush();
    }
  }

  /**
   * Flush events to server
   */
  async flush(sync = false) {
    if (this.eventQueue.length === 0) return;

    const eventsToSend = [...this.eventQueue];
    this.eventQueue = [];

    const payload = {
      events: eventsToSend,
      deploymentMode: this.config.deploymentMode,
      tenantId: this.config.tenantId,
      batchMetadata: {
        batchId: this.generateBatchId(),
        timestamp: Date.now(),
        eventCount: eventsToSend.length
      }
    };

    try {
      if (sync) {
        // Use sendBeacon for synchronous unload events
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(this.config.endpoint, blob);
      } else {
        // Regular async POST
        await fetch(this.config.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        });
      }
    } catch (error) {
      console.error('[FeatureTracker] Failed to send events:', error);
      // Re-queue failed events
      this.eventQueue.unshift(...eventsToSend);
    }
  }

  /**
   * Mask PII based on privacy level
   */
  maskPII(value) {
    if (!value) return null;
    
    switch (this.config.privacyLevel) {
      case 'strict':
        return this.hashValue(value); // Hash the value
      case 'standard':
        return this.maskValue(value); // Partial masking
      case 'relaxed':
        return value; // No masking
      default:
        return this.maskValue(value);
    }
  }

  /**
   * Sanitize metadata to remove sensitive information
   */
  sanitizeMetadata(metadata) {
    const sanitized = { ...metadata };
    const sensitiveFields = ['password', 'ssn', 'creditCard', 'pin', 'secret', 'token'];

    Object.keys(sanitized).forEach(key => {
      if (sensitiveFields.some(field => key.toLowerCase().includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof sanitized[key] === 'string' && sanitized[key].length > 100) {
        sanitized[key] = sanitized[key].slice(0, 100) + '...';
      }
    });

    return sanitized;
  }

  /**
   * Hash a value for strict privacy
   */
  hashValue(value) {
    let hash = 0;
    const str = String(value);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `hashed_${Math.abs(hash)}`;
  }

  /**
   * Partially mask a value
   */
  maskValue(value) {
    const str = String(value);
    if (str.length <= 4) return '****';
    return str.slice(0, 2) + '****' + str.slice(-2);
  }

  /**
   * Generate unique session ID
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique batch ID
   */
  generateBatchId() {
    return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    
    if (newConfig.enabled === false && this.config.enabled) {
      this.disable();
    } else if (newConfig.enabled === true && !this.config.enabled) {
      this.enable();
    }
  }

  /**
   * Enable tracking
   */
  enable() {
    this.config.enabled = true;
    this.initialize();
  }

  /**
   * Disable tracking
   */
  disable() {
    this.config.enabled = false;
    this.flush(true); // Flush remaining events
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
    }
  }

  /**
   * Get current journey path
   */
  getJourneyPath() {
    return this.journeyStack.map(s => s.step);
  }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FeatureTracker;
}

// Make available globally for browser usage
if (typeof window !== 'undefined') {
  window.FeatureTracker = FeatureTracker;
}

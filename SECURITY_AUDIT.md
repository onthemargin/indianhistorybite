# Security Audit Report - Indian History Bite

**Audit Date:** 2025-10-19
**Auditor:** Automated security review
**Application:** Indian History Bite v1.0.0
**Environment:** Node.js/Express web application

---

## Executive Summary

This security audit identifies vulnerabilities, security best practices, and recommendations for the Indian History Bite application. Overall, the application follows many security best practices but has some **CRITICAL** and **HIGH** priority issues that should be addressed immediately.

### Risk Summary

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 CRITICAL | 2 | Requires immediate action |
| 🟠 HIGH | 3 | Should fix soon |
| 🟡 MEDIUM | 4 | Recommended fixes |
| 🟢 LOW | 3 | Minor improvements |

---

## 🔴 CRITICAL Issues (Fix Immediately)

### 1. Vulnerable Dependencies - Axios DoS Vulnerability

**Severity:** CRITICAL
**CVE:** GHSA-4hjh-wcwx-xvwj
**Package:** axios 1.6.0 - 1.11.0
**Impact:** Denial of Service (DoS) attack through lack of data size check

**Details:**
```
axios  1.0.0 - 1.11.0
Severity: high
Axios is vulnerable to DoS attack through lack of data size check
```

**Risk:** An attacker could send requests that crash the server or consume excessive memory/CPU.

**Fix:**
```bash
cd app
npm update axios
# Or manually update package.json
npm install axios@latest
```

**Recommended Version:** axios@1.12.2 or higher

---

### 2. Hardcoded .env Path in server.js

**Severity:** CRITICAL
**File:** `app/src/server.js:5`
**Issue:** Hardcoded environment file path

**Code:**
```javascript
require('dotenv').config({ path: '/etc/indianhistorybite/.env' });
```

**Risk:**
- Development and local setups will fail if `/etc/indianhistorybite/.env` doesn't exist
- Forces specific deployment structure
- Prevents flexible environment configuration

**Fix:**
```javascript
// Load .env from standard locations
require('dotenv').config();
```

This will load `.env` from:
1. Current directory
2. Parent directories
3. Can be overridden with `NODE_ENV` specific files

**Alternative for production:**
```javascript
const path = require('path');
const dotenv = require('dotenv');

// Try production path first, fall back to local
if (process.env.NODE_ENV === 'production') {
    dotenv.config({ path: '/etc/indianhistorybite/.env' });
} else {
    dotenv.config();
}
```

---

## 🟠 HIGH Priority Issues

### 3. XSS Vulnerability - Unsafe innerHTML Usage

**Severity:** HIGH
**File:** `app/src/index.html:308, 325`
**Issue:** Using `innerHTML` with potentially unsanitized content

**Vulnerable Code:**
```javascript
// Line 308
storyBody.innerHTML = formattedContent;

// Line 325
storyBody.innerHTML = `<p>${data.response}</p>`;
```

**Risk:**
- If Claude API returns malicious HTML/JavaScript, it will execute in user's browser
- Cross-Site Scripting (XSS) attack vector
- Although `security.sanitizeInput()` is called on server, client should also validate

**Mitigation Already in Place:**
- Server-side sanitization in `security.js:196-213` (✅ GOOD)
- HTML tags are stripped
- Special characters are escaped

**Recommendation:**
Add client-side validation as defense-in-depth:

```javascript
function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Use textContent for plain text
storyTitle.textContent = storyData.name;
storySubtitle.textContent = storyData.title || '';

// For formatted content, use DOMPurify library
storyBody.innerHTML = DOMPurify.sanitize(formattedContent);
```

**Install DOMPurify:**
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"></script>
```

---

### 4. express-validator Vulnerability

**Severity:** HIGH
**CVE:** GHSA-9965-vmph-33xx
**Package:** express-validator (depends on vulnerable validator.js)
**Impact:** URL validation bypass vulnerability

**Details:**
```
validator  *
Severity: moderate
validator.js has a URL validation bypass vulnerability in its isURL function
No fix available
```

**Current Usage:**
```javascript
// security.js:78-82
body('prompt')
    .trim()
    .isLength({ min: 1, max: 5000 })
    .matches(/^[a-zA-Z0-9\s.,!?'"()-]+$/)
```

**Risk:**
- Currently NOT using URL validation, so impact is LIMITED
- If future code uses `isURL()`, it could be bypassed

**Recommendations:**
1. **Monitor for fix:** Check for express-validator updates regularly
2. **Avoid URL validation:** Don't use `isURL()` until patched
3. **Consider alternatives:**
   ```bash
   npm install joi
   # or
   npm install yup
   ```

---

### 5. Missing Content Security Policy (CSP)

**Severity:** HIGH
**File:** `app/src/security.js:48-73`
**Issue:** CSP allows `unsafe-inline` for scripts and styles

**Current Configuration:**
```javascript
styleSrc: ["'self'", "'unsafe-inline'"],
scriptSrc: ["'self'", "'unsafe-inline'"],
```

**Risk:**
- Allows inline JavaScript execution
- Weakens XSS protection
- `unsafe-inline` defeats the purpose of CSP

**Recommendation:**
Use nonces or hashes for inline scripts:

```javascript
contentSecurityPolicy: {
    directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'nonce-{NONCE}'"],
        scriptSrc: ["'self'", "'nonce-{NONCE}'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: []
    }
}
```

Generate nonce per request and add to HTML:
```html
<script nonce="{{ nonce }}">
    // Your inline code
</script>
```

---

## 🟡 MEDIUM Priority Issues

### 6. CORS Configuration Too Permissive in Development

**Severity:** MEDIUM
**File:** `app/src/server.js:43-56`
**Issue:** Default CORS allows all origins in development

**Code:**
```javascript
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3001'];

if (!origin || allowedOrigins.includes(origin)) {
    callback(null, true);
}
```

**Risk:**
- `!origin` allows requests with no origin header
- Allows browser extensions, Electron apps, mobile apps
- Could be exploited in CSRF attacks

**Recommendation:**
```javascript
const corsOptions = {
    origin: function (origin, callback) {
        // In production, always require origin
        if (process.env.NODE_ENV === 'production' && !origin) {
            return callback(new Error('Not allowed by CORS - origin required'));
        }

        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : ['http://localhost:3001'];

        // Allow if in allowedOrigins or no origin in dev
        if (allowedOrigins.includes(origin) || (!origin && process.env.NODE_ENV !== 'production')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    maxAge: 86400 // Cache preflight for 24 hours
};
```

---

### 7. No Request Size Limit

**Severity:** MEDIUM
**File:** `app/src/server.js:60`
**Issue:** Limited to 1mb but no streaming protection

**Code:**
```javascript
app.use(express.json({ limit: '1mb' }));
```

**Risk:**
- 1mb limit is good
- But no protection against slow-loris attacks
- No timeout on request body parsing

**Recommendation:**
```javascript
app.use(express.json({
    limit: '1mb',
    strict: true,
    verify: (req, res, buf) => {
        // Additional verification if needed
    }
}));

// Add request timeout
const timeout = require('connect-timeout');
app.use(timeout('30s'));
app.use((req, res, next) => {
    if (!req.timedout) next();
});
```

Install:
```bash
npm install connect-timeout
```

---

### 8. API Key Stored in Environment Variable

**Severity:** MEDIUM
**File:** `app/src/server.js:82`
**Issue:** Claude API key in environment variable (acceptable but not ideal)

**Current:**
```javascript
const apiKey = process.env.CLAUDE_API_KEY;
```

**Risk:**
- Environment variables can be exposed through `/proc` on Linux
- Process dumps may contain API keys
- Container environments may log env vars

**Recommendations:**
1. **Use secrets management in production:**
   - AWS Secrets Manager
   - HashiCorp Vault
   - Azure Key Vault
   - Google Secret Manager

2. **For Docker:**
   ```yaml
   services:
     app:
       secrets:
         - claude_api_key
   secrets:
     claude_api_key:
       file: ./secrets/claude_api_key.txt
   ```

3. **For Kubernetes:**
   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: api-keys
   data:
     claude-api-key: base64encodedkey
   ```

---

### 9. Prompt Injection Risk

**Severity:** MEDIUM
**File:** `app/src/server.js:170-186`
**Issue:** User input concatenated into prompt

**Code:**
```javascript
const prompt = `${basePrompt}\n\nGeneration ID: ${randomSeed}\nTimestamp: ${timestamp}\nIMPORTANT: This must be a completely different historical figure from any previous generation.`;
```

**Risk:**
- If `prompt.txt` is ever user-editable, injection attacks possible
- Attacker could manipulate Claude's output
- Could lead to inappropriate content generation

**Current Mitigation:**
- Prompt file is server-side only ✅
- Not user-editable through web interface ✅

**Recommendation:**
Add validation for prompt content:

```javascript
function validatePrompt(prompt) {
    // Check for suspiciously long prompts
    if (prompt.length > 10000) {
        throw new Error('Prompt too long');
    }

    // Check for injection attempts
    const suspiciousPatterns = [
        /ignore\s+previous\s+instructions/i,
        /system\s*:/i,
        /\[INST\]/i,
        /<\|im_start\|>/i
    ];

    for (const pattern of suspiciousPatterns) {
        if (pattern.test(prompt)) {
            console.warn('Suspicious prompt pattern detected');
            // Log for security monitoring
        }
    }

    return true;
}
```

---

## 🟢 LOW Priority Issues

### 10. No Rate Limiting on Static Files

**Severity:** LOW
**File:** `app/src/server.js:61`
**Issue:** Static files served without rate limiting

**Code:**
```javascript
app.use(basePath, express.static(__dirname, { maxAge: '1h' }));
```

**Risk:**
- Possible bandwidth exhaustion
- Static file enumeration

**Recommendation:**
```javascript
app.use(basePath,
    security.rateLimiters.general,
    express.static(__dirname, {
        maxAge: '1h',
        dotfiles: 'deny',
        index: false
    })
);
```

---

### 11. Verbose Error Messages in Development

**Severity:** LOW
**File:** `app/src/server.js:149, 199`
**Issue:** Error messages expose stack traces in development

**Code:**
```javascript
error: process.env.NODE_ENV === 'production' ? 'Processing failed' : error.message
```

**Risk:**
- Exposes internal paths and structure
- Could aid in reconnaissance

**Current Mitigation:**
- Only in development mode ✅
- Disabled in production ✅

**Recommendation:**
Use a logging library for better control:

```bash
npm install winston
```

```javascript
const winston = require('winston');

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}
```

---

### 12. Missing Security Headers

**Severity:** LOW
**File:** `app/src/security.js`
**Issue:** Some recommended headers missing

**Current Headers:** ✅
- X-Frame-Options
- X-Content-Type-Options
- HSTS

**Missing Headers:**
- `Referrer-Policy`
- `Permissions-Policy`
- `X-Permitted-Cross-Domain-Policies`

**Recommendation:**
```javascript
const securityHeaders = () => {
    return helmet({
        contentSecurityPolicy: { /* ... */ },
        hsts: { /* ... */ },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        permissionsPolicy: {
            features: {
                geolocation: ["'none'"],
                microphone: ["'none'"],
                camera: ["'none'"],
                payment: ["'none'"]
            }
        }
    });
};

// Add additional headers
app.use((req, res, next) => {
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
});
```

---

## ✅ Security Best Practices Already Implemented

The application demonstrates many good security practices:

### 1. **Rate Limiting** ✅
- General API: 100 requests per 15 minutes
- Refresh endpoint: 10 requests per hour
- Admin endpoints: 5 requests per hour

### 2. **Input Sanitization** ✅
```javascript
// security.js:196-213
const sanitizeInput = (input) => {
    if (typeof input !== 'string') return input;
    input = input.replace(/<[^>]*>?/gm, ''); // Remove HTML tags
    // Escape special characters
    return input.replace(/[&<>"'/]/g, char => escapeMap[char]);
};
```

### 3. **API Key Protection** ✅
```javascript
// Constant-time comparison prevents timing attacks
if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return res.status(401).json({ error: 'Invalid API key' });
}
```

### 4. **HTTPS Headers** ✅
```javascript
hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
}
```

### 5. **Secure Error Handling** ✅
```javascript
const message = process.env.NODE_ENV === 'production'
    ? 'An error occurred processing your request'
    : err.message;
```

### 6. **Request Logging** ✅
```javascript
// Logs suspicious activity (401, 403, 429)
if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429) {
    console.log('SECURITY:', JSON.stringify(log));
}
```

### 7. **Secure .gitignore** ✅
- .env files excluded
- SSL certificates excluded
- Runtime data excluded
- Node modules excluded

### 8. **CSRF Token Generation** ✅
```javascript
const generateCsrfToken = () => {
    const token = crypto.randomBytes(32).toString('hex');
    // Token expiration and cleanup
};
```

### 9. **Graceful Shutdown** ✅
```javascript
// Handles SIGTERM and SIGINT properly
// Closes connections gracefully
// 10-second force close timeout
```

---

## 📊 Dependency Security Analysis

### Current Dependencies Status

| Package | Current | Latest | Status |
|---------|---------|--------|--------|
| axios | 1.11.0 | 1.12.2 | 🔴 UPDATE REQUIRED |
| chokidar | 3.6.0 | 4.0.3 | 🟡 Update available (breaking changes) |
| dotenv | 16.6.1 | 17.2.3 | 🟡 Update available (breaking changes) |
| express | 4.21.2 | 5.1.0 | 🟡 Update available (major version) |
| express-rate-limit | 8.0.1 | 8.1.0 | 🟢 Minor update available |
| colors | 1.4.0 | 1.4.0 | ✅ Up to date |
| cors | 2.8.5 | 2.8.5 | ✅ Up to date |
| crypto-js | 4.2.0 | 4.2.0 | ✅ Up to date |
| express-validator | 7.2.1 | * | 🔴 Vulnerable |
| helmet | 8.1.0 | 8.1.0 | ✅ Up to date |

---

## 🔧 Immediate Action Items

### Priority 1 (Do Now)
1. **Update axios:** `npm install axios@latest`
2. **Fix hardcoded .env path:** Modify `server.js:5`
3. **Run npm audit fix:** `npm audit fix`

### Priority 2 (This Week)
1. **Implement CSP nonces:** Update security.js
2. **Add DOMPurify:** Protect against XSS
3. **Review CORS config:** Tighten production rules
4. **Monitor express-validator:** Check for security updates

### Priority 3 (This Month)
1. **Add request timeouts:** Install connect-timeout
2. **Implement structured logging:** Add winston
3. **Add missing security headers:** Update helmet config
4. **Consider secrets manager:** For production deployments

---

## 🛡️ Security Checklist for Production

Before deploying to production, ensure:

- [ ] All dependencies updated and `npm audit` shows 0 vulnerabilities
- [ ] `.env` file NOT committed to git
- [ ] Strong `APP_API_KEY` generated (32+ random bytes)
- [ ] `NODE_ENV=production` set
- [ ] HTTPS enabled with valid SSL certificate
- [ ] CORS configured with specific domains (no wildcards)
- [ ] Rate limiting enabled and tested
- [ ] Error messages don't expose internal details
- [ ] API keys stored in secrets manager
- [ ] Security headers verified (use securityheaders.com)
- [ ] CSP tested and no console errors
- [ ] Logs reviewed for security events
- [ ] Backup and monitoring configured
- [ ] Firewall rules configured (only ports 80, 443, 22)
- [ ] Regular security updates scheduled

---

## 📚 Recommended Security Resources

1. **OWASP Top 10:** https://owasp.org/www-project-top-ten/
2. **Node.js Security Best Practices:** https://nodejs.org/en/docs/guides/security/
3. **Express Security:** https://expressjs.com/en/advanced/best-practice-security.html
4. **npm Security:** https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities
5. **Helmet.js:** https://helmetjs.github.io/

---

## 📝 Conclusion

The Indian History Bite application demonstrates a **solid security foundation** with proper implementation of:
- Rate limiting
- Input sanitization
- API authentication
- Secure headers
- Error handling

However, **immediate action is required** to address:
1. Vulnerable axios dependency (DoS risk)
2. Hardcoded environment path (deployment issues)
3. XSS protection gaps (innerHTML usage)

The development team should prioritize fixing CRITICAL and HIGH severity issues before production deployment.

**Overall Security Rating: B** (Good, but needs immediate fixes)

---

**Next Review Date:** 2025-11-19 (30 days)
**Reviewer Signature:** Automated Security Audit Tool

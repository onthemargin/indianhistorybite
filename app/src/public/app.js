// Decode HTML entities
function decodeHTML(html) {
    const txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
}

// XSS Protection: Simplified sanitization for trusted content
function sanitizeHTML(dirty) {
    // Since content comes from our own API and we control the formatting,
    // we just need basic sanitization
    const temp = document.createElement('div');
    temp.innerHTML = dirty;

    // Remove any script tags or event handlers as a safety measure
    const scripts = temp.querySelectorAll('script');
    scripts.forEach(script => script.remove());

    // Remove event handler attributes
    const allElements = temp.querySelectorAll('*');
    allElements.forEach(el => {
        const attrs = Array.from(el.attributes);
        attrs.forEach(attr => {
            if (attr.name.startsWith('on')) {
                el.removeAttribute(attr.name);
            }
        });
    });

    return temp.innerHTML;
}

// Determine base path from current URL (supports nested deploys)
function getBasePath() {
    const path = window.location.pathname;
    const parts = path.split('/').filter(Boolean);
    return parts.length > 0 ? `/${parts[0]}` : '';
}

// Fetch and display content with robust parsing
async function fetchResult() {
    try {
        const cacheBuster = new Date().getTime();
        const base = getBasePath() || '/indianhistorybite';
        const url = `${base}/api/result?t=${cacheBuster}`;
        const response = await fetch(url, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache'
            }
        });

        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) {
            let bodyText = '';
            try { bodyText = await response.text(); } catch (_) {}
            throw new Error(`HTTP ${response.status} ${response.statusText} - ${bodyText.slice(0, 200)}`);
        }

        let data;
        if (contentType.includes('application/json') || contentType.includes('json')) {
            data = await response.json();
        } else {
            const text = await response.text();
            try {
                data = JSON.parse(text);
            } catch (_) {
                throw new Error(`Expected JSON but received ${contentType || 'unknown'}: ${text.slice(0, 200)}`);
            }
        }

        displayStoryContent(data);
    } catch (error) {
        document.getElementById('story-title').textContent = 'Connection Error';
        document.getElementById('story-subtitle').textContent = '';
        document.getElementById('story-body').innerHTML = sanitizeHTML(`<div class="error">Unable to load content: ${error.message}</div>`);
        document.getElementById('story-quote').style.display = 'none';
    }
}

// Display story content
function displayStoryContent(data) {
    const storyTitle = document.getElementById('story-title');
    const storySubtitle = document.getElementById('story-subtitle');
    const storyBody = document.getElementById('story-body');
    const storyQuote = document.getElementById('story-quote');

    if (data.error) {
        storyTitle.textContent = 'Error';
        storySubtitle.textContent = '';
        storyBody.innerHTML = sanitizeHTML(`<div class="error">${data.error}</div>`);
        storyQuote.style.display = 'none';
    } else if (data.isProcessing) {
        storyTitle.textContent = 'Loading your history story...';
        storySubtitle.textContent = '';
        storyBody.innerHTML = sanitizeHTML('<div class="loading">📚 Preparing today\'s historical tale...</div>');
        storyQuote.style.display = 'none';
    } else {
        try {
            let storyData;

            // Handle response - it should now be an object directly from server
            if (typeof data.response === 'object' && data.response !== null) {
                // Response is already an object
                storyData = data.response;
            } else if (typeof data.response === 'string') {
                // Fallback: try to parse string response
                storyData = JSON.parse(data.response);
            } else {
                throw new Error('Invalid response format');
            }

            if (storyData.name && storyData.content) {
                // Display the name prominently
                storyTitle.textContent = storyData.name;
                storySubtitle.textContent = storyData.title || '';

                // Process the content for better formatting
                let content = storyData.content;

                // Split into paragraphs (handling both \n\n and single \n)
                let paragraphs = content.split(/\n\n|\n(?=[A-Z])/);

                // Format each paragraph
                let formattedContent = paragraphs.map(paragraph => {
                    // Skip empty paragraphs
                    if (!paragraph.trim()) return '';

                    // Apply text formatting directly (content is plain text from JSON)
                    let formatted = paragraph
                        // Bold text
                        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                        // Italic text
                        .replace(/\*(.*?)\*/g, '<em>$1</em>')
                        // Quotes
                        .replace(/"([^"]+)"/g, '"<span class="quote-inline">$1</span>"');

                    return `<p>${formatted}</p>`;
                }).filter(p => p !== '').join('');

                // Insert sanitized content
                storyBody.innerHTML = sanitizeHTML(formattedContent);

                // Display the quote if available (use textContent for safety)
                if (storyData.shareableQuote) {
                    storyQuote.textContent = storyData.shareableQuote;
                    storyQuote.style.display = 'block';
                } else {
                    storyQuote.style.display = 'none';
                }
            } else {
                throw new Error('Invalid story format');
            }
        } catch (e) {
            // Fallback for non-JSON content
            console.error('Error parsing story:', e);
            console.error('Response type:', typeof data.response);
            console.error('Response sample:', data.response ? data.response.substring(0, 200) : 'null');

            storyTitle.textContent = 'Parsing Error';
            storySubtitle.textContent = '';
            storyBody.innerHTML = sanitizeHTML(`<div class="error">Unable to parse story content. Error: ${e.message}</div>`);
            storyQuote.style.display = 'none';
        }
    }
}

// Load content on page load
document.addEventListener('DOMContentLoaded', fetchResult);

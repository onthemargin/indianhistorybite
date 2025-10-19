#!/usr/bin/env node

const axios = require('axios');
const colors = require('colors/safe');

// Configure colors theme
colors.setTheme({
    title: ['cyan', 'bold'],
    subtitle: ['yellow', 'italic'],
    section: ['green', 'bold'],
    content: 'white',
    quote: ['magenta', 'italic'],
    error: ['red', 'bold'],
    info: ['blue']
});

async function fetchAndFormatStory() {
    try {
        // Fetch the current story
        const response = await axios.get('http://127.0.0.1:3001/indianhistorybite/api/result');
        const data = response.data;
        
        if (data.error) {
            console.log(colors.error('❌ Error: ') + data.error);
            return;
        }
        
        if (data.isProcessing) {
            console.log(colors.info('⏳ Story is being generated...'));
            return;
        }
        
        // Parse the nested JSON response
        let story;
        try {
            story = typeof data.response === 'string' ? JSON.parse(data.response) : data.response;
        } catch (e) {
            // If not JSON, display as plain text
            console.log(colors.content(data.response));
            return;
        }
        
        // Format and display the story
        console.log('\n' + '═'.repeat(80));
        console.log(colors.title(`📚 ${story.name}`));
        console.log(colors.subtitle(`   ${story.title}`));
        console.log('═'.repeat(80) + '\n');
        
        // Format content with proper line breaks and styling
        const paragraphs = story.content.split('\\n\\n');
        paragraphs.forEach(paragraph => {
            // Handle bold text
            let formatted = paragraph.replace(/\*\*(.*?)\*\*/g, (match, p1) => colors.bold(p1));
            
            // Wrap text at 80 characters
            const words = formatted.split(' ');
            let line = '';
            words.forEach(word => {
                if ((line + word).length > 78) {
                    console.log(colors.content(line));
                    line = word + ' ';
                } else {
                    line += word + ' ';
                }
            });
            if (line.trim()) {
                console.log(colors.content(line));
            }
            console.log(); // Empty line between paragraphs
        });
        
        // Display shareable quote
        if (story.shareableQuote) {
            console.log('─'.repeat(80));
            console.log(colors.quote(`\n"${story.shareableQuote}"\n`));
            console.log('─'.repeat(80));
        }
        
        // Display metadata
        if (data.lastModified) {
            const date = new Date(data.lastModified);
            console.log(colors.info(`\n📅 Last Updated: ${date.toLocaleString()}`));
        }
        
        console.log('\n' + '═'.repeat(80) + '\n');
        
    } catch (error) {
        console.log(colors.error('❌ Failed to fetch story:'), error.message);
        if (error.response) {
            console.log(colors.error('Response status:'), error.response.status);
        }
    }
}

// Add watch mode
const args = process.argv.slice(2);
if (args.includes('--watch') || args.includes('-w')) {
    console.log(colors.info('👀 Watching for changes... (Press Ctrl+C to exit)\n'));
    
    // Initial fetch
    fetchAndFormatStory();
    
    // Poll every 5 seconds
    setInterval(() => {
        console.clear();
        fetchAndFormatStory();
    }, 5000);
} else {
    // Single fetch
    fetchAndFormatStory();
}
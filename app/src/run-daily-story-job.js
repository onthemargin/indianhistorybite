const fs = require('fs');
const dotenv = require('dotenv');

if (process.env.NODE_ENV === 'production' && fs.existsSync('/etc/indianhistorybite/.env')) {
    dotenv.config({ path: '/etc/indianhistorybite/.env' });
} else {
    dotenv.config();
}

const scheduler = require('./story-scheduler');

async function main() {
    const storyDateKey = process.argv[2] || scheduler.getStoryDateKey();
    const result = await scheduler.runDailyStoryJob({ storyDateKey });
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

// Ensure the wallpapers directory exists
if (!fs.existsSync('wallpapers')) {
    fs.mkdirSync('wallpapers');
}

function generateRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function getOTP(targetEmail) {
    if (!process.env.GMAIL_APP_PASSWORD) {
        throw new Error('GMAIL_APP_PASSWORD environment variable is not set!');
    }

    // Try up to 30 attempts, checking every 5 seconds (2.5 minutes total)
    for (let attempt = 1; attempt <= 30; attempt++) {
        console.log(`Checking inbox for OTP (Attempt ${attempt}/30)...`);

        const client = new ImapFlow({
            host: 'imap.gmail.com',
            port: 993,
            secure: true,
            auth: {
                user: 'holaexplainer@gmail.com',
                pass: process.env.GMAIL_APP_PASSWORD
            },
            logger: false
        });

        try {
            await client.connect();
            
            // Lock mailbox to ensure state is synchronized and fresh
            let lock = await client.getMailboxLock('INBOX');
            try {
                // Broad search by subject. Gmail returns UIDs in ascending order (oldest to newest)
                let uids = await client.search({
                    subject: 'ChatGPT'
                });

                console.log(`Found ${uids.length} email(s) with 'ChatGPT' in the subject.`);

                if (uids && uids.length > 0) {
                    const uid = uids[uids.length - 1];
                    const msg = await client.fetchOne(uid, { source: true });
                    
                    // Parse raw email structure
                    const parsed = await simpleParser(msg.source);
                    const text = parsed.text || '';
                    const html = parsed.html || '';
                    
                    // Extract recipient details
                    const toText = (parsed.to && parsed.to.text) ? parsed.to.text.toLowerCase() : '';
                    const parsedEmails = parsed.to && parsed.to.value 
                        ? parsed.to.value.map(val => (val.address || '').toLowerCase()) 
                        : [];

                    console.log(`Checking newest UID: ${uid} | Recipient Header: "${toText}"`);

                    // Verify if target email is the recipient
                    const isMatch = toText.includes(targetEmail.toLowerCase()) || 
                                    parsedEmails.includes(targetEmail.toLowerCase()) || 
                                    text.includes(targetEmail) ||
                                    html.includes(targetEmail);

                    if (isMatch) {
                        // Find 6-digit OTP code
                        const otpRegex = /\b\d{6}\b/;
                        let match = text.match(otpRegex);
                        if (!match) {
                            match = html.match(otpRegex);
                        }

                        if (match) {
                            const otp = match[0];
                            console.log(`Found OTP: ${otp} for ${targetEmail}`);
                            return otp;
                        } else {
                            console.log(`Could not extract a 6-digit OTP code from message UID: ${uid}.`);
                        }
                    }
                }
            } finally {
                // Release lock on INBOX
                lock.release();
            }
        } catch (err) {
            console.error(`IMAP connection/search error on attempt ${attempt}:`, err);
        } finally {
            await client.logout().catch(() => {});
        }

        // Wait 5 seconds before checking again
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error(`OTP email not found for ${targetEmail} after 30 attempts.`);
}

async function createNewSession() {
    console.log('\n--- Creating New Browser Session and Registering New Account ---');
    const browser = await chromium.launch({ headless: true });
    
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);

    try {
        console.log('Navigating to ChatGPT...');
        await page.goto('https://chatgpt.com/', { waitUntil: 'load', timeout: 0 });

        const loginBtn = page.locator('[data-testid="login-button"]');
        await loginBtn.waitFor({ state: 'visible', timeout: 0 });
        await loginBtn.click();

        const emailInput = page.locator('input#email');
        await emailInput.waitFor({ state: 'visible', timeout: 0 });

        const randomString = generateRandomString(6);
        const email = `holaexplainer+${randomString}@gmail.com`;
        console.log(`Registering account with email: ${email}`);

        await emailInput.fill(email);
        await emailInput.press('Enter');

        // Fallback: If still on the same page after 2 seconds, click the Continue button directly
        await page.waitForTimeout(2000);
        const continueBtn = page.locator('button[type="submit"]:has-text("Continue"), button:has-text("Continue")');
        if (await continueBtn.count() > 0 && await continueBtn.isVisible()) {
            console.log('Clicking the Continue button directly...');
            await continueBtn.click();
        }

        console.log('Waiting for verification page (waiting for code input)...');
        const codeInput = page.locator('input[name="code"], input[placeholder="Code"], input[id$="-code"]');
        await codeInput.waitFor({ state: 'visible', timeout: 0 });

        // Get OTP from Gmail inbox
        console.log(`Starting fetching OTP for ${email}...`);
        const otp = await getOTP(email);
        console.log(`Successfully retrieved OTP: ${otp}`);

        // Enter OTP code
        console.log('Typing OTP code...');
        await codeInput.fill(otp);

        const submitBtn = page.locator('button[type="submit"][value="validate"], button:has-text("Continue")');
        await submitBtn.click();

        // Wait for profile setup form (About You) page
        console.log('Waiting for Profile Setup (About You) page to load...');
        const nameInput = page.locator('input[name="name"], input[placeholder="Full name"]');
        await nameInput.waitFor({ state: 'visible', timeout: 0 });

        console.log('Filling Profile Info (Name & Age)...');
        await nameInput.fill('jahid hasan');

        const ageInput = page.locator('input[name="age"], input[placeholder="Age"]');
        await ageInput.waitFor({ state: 'visible', timeout: 0 });
        await ageInput.fill('30');

        console.log('Submitting Profile Info...');
        const finishBtn = page.locator('button[type="submit"]:has-text("Finish creating account"), button:has-text("Finish creating account")');
        await finishBtn.click();

        console.log('Waiting for redirect back to ChatGPT...');
        await page.waitForURL('**/chatgpt.com/**', { waitUntil: 'domcontentloaded', timeout: 0 });

        // Wait a brief moment to let any welcome popup render
        await page.waitForTimeout(5000);

        // Check if "You're all set" popup or dialog with 'Continue' button exists
        const allSetBtn = page.locator('button.btn-primary:has-text("Continue"), button:has-text("Continue")');
        if (await allSetBtn.count() > 0) {
            console.log('"You\'re all set" button found. Clicking it...');
            await allSetBtn.first().click();
            await page.waitForTimeout(2000);
        }

        console.log('New account session successfully created and logged in.');

        // Append email to emails.txt in the root directory
        const emailsFilePath = path.join(__dirname, 'emails.txt');
        fs.appendFileSync(emailsFilePath, `${email}\n`, 'utf8');
        console.log(`Saved registered email: ${email} to ${emailsFilePath}`);

        return { browser, page };

    } catch (error) {
        console.error('An error occurred during account creation:', error);
        await page.screenshot({ path: 'wallpapers/error_signup.png', fullPage: true });
        await browser.close();
        throw error;
    }
}

(async () => {
    // Check credentials first
    if (!process.env.GMAIL_APP_PASSWORD) {
        console.error('ERROR: GMAIL_APP_PASSWORD environment variable is not defined.');
        process.exit(1);
    }

    // Read prompts from prompts.txt
    let prompts = [];
    const promptsPath = path.join(__dirname, 'prompts.txt');
    if (fs.existsSync(promptsPath)) {
        prompts = fs.readFileSync(promptsPath, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        console.log(`Loaded ${prompts.length} prompt(s) from prompts.txt.`);
    }

    if (prompts.length === 0) {
        console.log('No prompts found in prompts.txt. Using default prompts...');
        prompts = [
            'Create image a wallpaper 9:16 ratio of a serene mountain sunrise',
            'Create image a wallpaper 9:16 ratio of a neon cyberpunk city street',
            'Create image a wallpaper 9:16 ratio of a futuristic spaceship in orbit'
        ];
    }

    let currentSession = null;
    let generationsOnCurrentAccount = 0;

    for (let i = 0; i < prompts.length; i++) {
        let prompt = prompts[i];
        
        // Auto-prepend instruction if not already present in prompts.txt
        const prefix = "Create image a wallpaper 9:16 ratio of ";
        if (!prompt.toLowerCase().startsWith("create image")) {
            prompt = prefix + prompt;
        }

        console.log(`\n======================================================`);
        console.log(`Processing Prompt ${i + 1}/${prompts.length}`);
        console.log(`Prompt: "${prompt}"`);
        console.log(`======================================================`);

        // Rotate browser session / account if generations reach limit of 5
        if (!currentSession || generationsOnCurrentAccount >= 5) {
            if (currentSession) {
                console.log('Reached 5 generations limit on this account. Closing browser and rotating account...');
                await currentSession.browser.close();
            }
            try {
                currentSession = await createNewSession();
                generationsOnCurrentAccount = 0;
            } catch (err) {
                console.error('Failed to rotate account session. Retrying in 10 seconds...');
                await new Promise(res => setTimeout(res, 10000));
                i--; // Retry this prompt in the next iteration
                continue;
            }
        }

        const page = currentSession.page;

        try {
            console.log('Resetting interface to start a fresh chat session...');
            await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 0 });

            console.log('Locating prompt input text area (#prompt-textarea)...');
            const promptArea = page.locator('#prompt-textarea');
            await promptArea.waitFor({ state: 'visible', timeout: 0 });

            console.log('Focusing and typing the image prompt...');
            await promptArea.click();
            await page.keyboard.type(prompt);
            await page.waitForTimeout(1000);

            console.log('Locating send button...');
            const sendBtn = page.locator('[data-testid="send-button"], #composer-submit-button');
            await sendBtn.waitFor({ state: 'visible', timeout: 0 });

            console.log('Clicking the send button...');
            await sendBtn.click();

            console.log('Waiting for image generation to complete (waiting for Share button)...');
            const shareBtn = page.locator('button[aria-label="Share this image"]').first();
            await shareBtn.waitFor({ state: 'visible', timeout: 0 });

            console.log('Image generated successfully. Hovering and clicking Share...');
            const imageContainer = page.locator('.group\\/imagegen-image').first();
            if (await imageContainer.count() > 0) {
                await imageContainer.hover().catch(() => {});
            }
            await shareBtn.click();

            console.log('Waiting for share modal to load...');
            const downloadBtn = page.locator('button:has-text("Download")').first();
            await downloadBtn.waitFor({ state: 'visible', timeout: 0 });

            console.log('Interceptors ready. Clicking the download button inside the share modal...');
            const downloadPromise = page.waitForEvent('download');
            await downloadBtn.click();
            const download = await downloadPromise;

            // Save the download file
            const fileIndex = i + 1;
            const filePath = path.join('wallpapers', `wallpaper_${fileIndex}.png`);
            await download.saveAs(filePath);
            console.log(`Wallpaper successfully downloaded and saved to: ${filePath}`);

            // Close the share modal
            const closeBtn = page.locator('button[data-testid="close-button"]').first();
            if (await closeBtn.count() > 0) {
                await closeBtn.click().catch(() => {});
            }

            generationsOnCurrentAccount++;
            console.log(`Generations on current account: ${generationsOnCurrentAccount}/5`);

        } catch (error) {
            console.error(`Error processing prompt ${i + 1}:`, error);
            await page.screenshot({ path: `wallpapers/error_prompt_${i + 1}.png`, fullPage: true });
        }
    }

    if (currentSession) {
        await currentSession.browser.close();
        console.log('\nAll prompts processed. Browser closed.');
    }
})();

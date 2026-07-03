const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');

chromium.use(stealth);

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

    await client.connect();
    console.log('Connected to Gmail IMAP server successfully.');

    try {
        // Try up to 30 attempts, checking every 5 seconds (2.5 minutes total)
        for (let attempt = 1; attempt <= 30; attempt++) {
            console.log(`Checking inbox for OTP (Attempt ${attempt}/30)...`);
            
            // Lock mailbox to ensure state is synchronized and fresh
            let lock = await client.getMailboxLock('INBOX');
            try {
                // Search for any messages containing "ChatGPT" in the subject
                let uids = await client.search({
                    subject: 'ChatGPT'
                });

                console.log(`Found ${uids.length} email(s) with 'ChatGPT' in the subject.`);

                if (uids && uids.length > 0) {
                    // Iterate from newest to oldest
                    for (let i = uids.length - 1; i >= 0; i--) {
                        const uid = uids[i];
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

                        console.log(`UID: ${uid} | Subject: "${parsed.subject}" | Recipient Header: "${toText}"`);

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
                }
            } finally {
                // Release lock on INBOX
                lock.release();
            }

            // Wait 5 seconds before checking again
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        throw new Error(`OTP email not found for ${targetEmail} after 30 attempts.`);
    } finally {
        await client.logout();
        console.log('Logged out of Gmail IMAP server.');
    }
}

(async () => {
    // Check for credentials first
    if (!process.env.GMAIL_APP_PASSWORD) {
        console.error('ERROR: GMAIL_APP_PASSWORD environment variable is not defined.');
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // Disable all default timeouts to handle slow internet speeds
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);

    try {
        console.log('Navigating to ChatGPT...');
        await page.goto('https://chatgpt.com/', { waitUntil: 'load', timeout: 0 });

        const loginBtn = page.locator('[data-testid="login-button"]');
        console.log('Waiting for login button...');
        await loginBtn.waitFor({ state: 'visible', timeout: 0 });

        // Screenshot 1: Homepage
        await page.screenshot({ path: 'screenshots/1_homepage.png' });

        console.log('Clicking login button...');
        await loginBtn.click();

        console.log('Waiting for login form/email input...');
        const emailInput = page.locator('input#email');
        await emailInput.waitFor({ state: 'visible', timeout: 0 });

        // Generate customized email alias
        const randomString = generateRandomString(6);
        const email = `holaexplainer+${randomString}@gmail.com`;
        console.log(`Generated email: ${email}`);

        await emailInput.fill(email);

        // Screenshot 2: Email Filled
        await page.screenshot({ path: 'screenshots/2_email_filled.png' });

        console.log('Pressing Enter/Submit...');
        await emailInput.press('Enter');

        console.log('Waiting for redirection to verification page...');
        await page.waitForURL('**/email-verification**', { waitUntil: 'load', timeout: 0 });
        console.log('Redirected to verification page:', page.url());

        // Screenshot 3: Verification Page
        await page.screenshot({ path: 'screenshots/3_verification_page.png', fullPage: true });

        // Get OTP from Gmail inbox
        console.log(`Starting fetching OTP for ${email}...`);
        const otp = await getOTP(email);
        console.log(`Successfully retrieved OTP: ${otp}`);

        // Enter OTP code
        console.log('Typing OTP code...');
        const codeInput = page.locator('input[name="code"], input[placeholder="Code"], input[id$="-code"]');
        await codeInput.waitFor({ state: 'visible', timeout: 0 });
        await codeInput.fill(otp);

        // Screenshot 4: OTP Entered
        await page.screenshot({ path: 'screenshots/4_otp_entered.png' });

        console.log('Submitting OTP code...');
        const submitBtn = page.locator('button[type="submit"][value="validate"], button:has-text("Continue")');
        await submitBtn.click();

        // Wait for profile setup form (About You) page
        console.log('Waiting for Profile Setup (About You) page to load...');
        const nameInput = page.locator('input[name="name"], input[placeholder="Full name"]');
        await nameInput.waitFor({ state: 'visible', timeout: 0 });

        // Screenshot 5: Profile Page
        await page.screenshot({ path: 'screenshots/5_profile_page.png' });

        console.log('Filling Profile Info (Name & Age)...');
        await nameInput.fill('jahid hasan');

        const ageInput = page.locator('input[name="age"], input[placeholder="Age"]');
        await ageInput.waitFor({ state: 'visible', timeout: 0 });
        await ageInput.fill('30');

        // Screenshot 6: Profile Filled
        await page.screenshot({ path: 'screenshots/6_profile_filled.png' });

        console.log('Submitting Profile Info...');
        const finishBtn = page.locator('button[type="submit"]:has-text("Finish creating account"), button:has-text("Finish creating account")');
        await finishBtn.click();

        console.log('Waiting for redirect back to ChatGPT...');
        await page.waitForURL('**/chatgpt.com/**', { waitUntil: 'load', timeout: 0 });

        // Wait a brief moment to let any welcome popup render
        await page.waitForTimeout(5000);

        // Check if "You're all set" popup or dialog with 'Continue' button exists
        const allSetBtn = page.locator('button.btn-primary:has-text("Continue"), button:has-text("Continue")');
        if (await allSetBtn.count() > 0) {
            console.log('"You\'re all set" button found. Clicking it...');
            await allSetBtn.first().click();
            await page.waitForTimeout(2000);
        }

        // Screenshot 7: Dashboard page
        await page.screenshot({ path: 'screenshots/7_final_page.png', fullPage: true });
        console.log('Final page reached. Locating prompt input text area (#prompt-textarea)...');

        const promptArea = page.locator('#prompt-textarea');
        await promptArea.waitFor({ state: 'visible', timeout: 0 });

        console.log('Focusing and typing the image prompt...');
        await promptArea.click();
        
        // Type the prompt simulating keypresses
        await page.keyboard.type('Create image a wallpaper 9:16 ratio');
        await page.waitForTimeout(2000);

        // Screenshot 8: Prompt typed
        await page.screenshot({ path: 'screenshots/8_prompt_typed.png' });

        console.log('Locating send button...');
        const sendBtn = page.locator('[data-testid="send-button"], #composer-submit-button');
        await sendBtn.waitFor({ state: 'visible', timeout: 0 });

        console.log('Clicking the send button...');
        await sendBtn.click();

        console.log('Waiting for image generation to complete (this might take 30-60 seconds)...');
        // Wait for the generated image element to be visible
        const generatedImg = page.locator('img[alt^="Generated image:"], [data-testid^="conversation-turn-"] img[src*="backend-api/estuary/content"]');
        await generatedImg.waitFor({ state: 'visible', timeout: 0 });

        console.log('Image generation complete! Waiting for loading transition...');
        await page.waitForTimeout(2000);

        // Screenshot 9: Final response screen with the wallpaper visible
        await page.screenshot({ path: 'screenshots/9_final_result.png', fullPage: true });
        console.log('Final conversation screenshot captured.');

        // Get the image URL (src)
        const imgSrc = await generatedImg.first().getAttribute('src');
        if (imgSrc) {
            console.log(`Downloading generated wallpaper from: ${imgSrc}`);
            // Use page.request.get to download using the page's cookies and headers
            const response = await page.request.get(imgSrc);
            if (response.ok()) {
                const buffer = await response.body();
                fs.writeFileSync('screenshots/wallpaper.png', buffer);
                console.log('Wallpaper successfully saved to screenshots/wallpaper.png');
            } else {
                console.error(`Failed to download wallpaper. Status: ${response.status()}`);
            }
        } else {
            console.error('Could not retrieve image source URL.');
        }

    } catch (error) {
        console.error('An error occurred during flow execution:', error);
        await page.screenshot({ path: 'screenshots/error.png', fullPage: true });
    } finally {
        await browser.close();
    }
})();

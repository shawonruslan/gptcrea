const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
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

async function createNewSession() {
    console.log('\n--- Creating New Browser Session and Registering New Account ---');
    const browser = await chromium.launch({ headless: true });
    
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        recordVideo: {
            dir: 'wallpapers/',
            size: { width: 1280, height: 800 }
        }
    });

    const page = await context.newPage();
    const mailwavePage = await context.newPage(); // Open temp mail in a second tab
    
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);
    mailwavePage.setDefaultTimeout(0);
    mailwavePage.setDefaultNavigationTimeout(0);

    try {
        // Step 1: Generate disposable email address
        console.log('Navigating to mailwave.dev to generate temp email...');
        await mailwavePage.goto('https://mailwave.dev/', { waitUntil: 'load', timeout: 0 });
        
        console.log('Waiting for email address generation...');
        const emailInput = mailwavePage.locator('input#mainEmail');
        await emailInput.waitFor({ state: 'visible', timeout: 0 });
        
        let email = '';
        for (let attempt = 1; attempt <= 30; attempt++) {
            email = await emailInput.inputValue();
            if (email && email !== 'landing' && email.includes('@')) {
                break;
            }
            await mailwavePage.waitForTimeout(1000);
        }
        
        if (!email || email === 'landing') {
            throw new Error('Failed to generate email on mailwave.dev');
        }
        
        console.log(`Successfully generated email: ${email}`);

        // Step 2: Register on ChatGPT
        console.log('Navigating to ChatGPT...');
        await page.goto('https://chatgpt.com/', { waitUntil: 'load', timeout: 0 });

        const loginBtn = page.locator('[data-testid="login-button"]');
        await loginBtn.waitFor({ state: 'visible', timeout: 0 });
        await loginBtn.click();

        const chatgptEmailInput = page.locator('input#email');
        await chatgptEmailInput.waitFor({ state: 'visible', timeout: 0 });

        console.log(`Entering registration email: ${email}`);
        await chatgptEmailInput.fill(email);
        await chatgptEmailInput.press('Enter');

        // Fallback: If still on same screen, click Continue button directly
        await page.waitForTimeout(2000);
        const continueBtn = page.locator('button[type="submit"]:has-text("Continue"), button:has-text("Continue")');
        if (await continueBtn.count() > 0 && await continueBtn.isVisible()) {
            console.log('Clicking the Continue button directly...');
            await continueBtn.click();
        }

        console.log('Waiting for verification page (waiting for code input)...');
        const codeInput = page.locator('input[name="code"], input[placeholder="Code"], input[id$="-code"]');
        await codeInput.waitFor({ state: 'visible', timeout: 0 });

        // Step 3: Fetch verification code from mailwavePage
        console.log('Switching to mailwave.dev tab to wait for OTP...');
        const mailboxItem = mailwavePage.locator('#mailbox .mailbox-item');
        
        let emailArrived = false;
        for (let attempt = 1; attempt <= 30; attempt++) {
            if (await mailboxItem.count() > 0) {
                const text = await mailboxItem.first().textContent();
                if (text.includes('ChatGPT') || text.includes('verification code')) {
                    emailArrived = true;
                    break;
                }
            }
            console.log(`Email not arrived yet (attempt ${attempt}/30). Refreshing inbox...`);
            await mailwavePage.locator('#refresh').click().catch(() => {});
            await mailwavePage.waitForTimeout(5000);
        }

        if (!emailArrived) {
            throw new Error('Verification email from ChatGPT did not arrive on mailwave.dev.');
        }

        console.log('Verification email arrived! Opening message...');
        await mailboxItem.first().click();
        await mailwavePage.waitForTimeout(3000);

        // Step 4: Extract OTP from the page body
        console.log('Extracting OTP code...');
        const bodyText = await mailwavePage.locator('body').textContent();
        const otpMatch = bodyText.match(/\b\d{6}\b/);
        if (!otpMatch) {
            throw new Error('Could not find 6-digit OTP code on the email content.');
        }
        
        const otp = otpMatch[0];
        console.log(`Successfully retrieved OTP: ${otp}`);

        // Step 5: Fill in OTP and complete ChatGPT setup
        console.log('Switching back to ChatGPT and typing OTP code...');
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

        // Wait a brief moment to let welcome popups render
        await page.waitForTimeout(5000);

        // Check if "You're all set" popup or dialog exists
        const allSetBtn = page.locator('button.btn-primary:has-text("Continue"), button:has-text("Continue")');
        if (await allSetBtn.count() > 0) {
            console.log('"You\'re all set" button found. Clicking it...');
            await allSetBtn.first().click();
            await page.waitForTimeout(2000);
        }

        // Close the temp mail tab as we are successfully signed up
        await mailwavePage.close().catch(() => {});

        console.log('New account session successfully created and logged in.');

        // Append email to emails.txt in the root directory
        const emailsFilePath = path.join(__dirname, 'emails.txt');
        fs.appendFileSync(emailsFilePath, `${email}\n`, 'utf8');
        console.log(`Saved registered email: ${email} to ${emailsFilePath}`);

        return { browser, page };

    } catch (error) {
        console.error('An error occurred during account creation:', error);
        await page.screenshot({ path: 'wallpapers/error_signup.png', fullPage: true });
        const video = page.video();
        await browser.close();
        if (video) {
            const videoPath = await video.path().catch(() => null);
            if (videoPath && fs.existsSync(videoPath)) {
                const newVideoPath = path.join('wallpapers', 'error_signup_record.webm');
                fs.renameSync(videoPath, newVideoPath);
                console.log(`Saved error signup video record to: ${newVideoPath}`);
            }
        }
        throw error;
    }
}

(async () => {
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
    let accountIndex = 1;

    for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        console.log(`\n======================================================`);
        console.log(`Processing Prompt ${i + 1}/${prompts.length}`);
        console.log(`Prompt: "${prompt}"`);
        console.log(`======================================================`);

        // Rotate browser session / account if generations reach limit of 5
        if (!currentSession || generationsOnCurrentAccount >= 5) {
            if (currentSession) {
                console.log('Reached 5 generations limit on this account. Closing browser and rotating account...');
                const page = currentSession.page;
                const video = page.video();
                await currentSession.browser.close();
                if (video) {
                    const videoPath = await video.path().catch(() => null);
                    if (videoPath && fs.existsSync(videoPath)) {
                        const newVideoPath = path.join('wallpapers', `account_${accountIndex}_record.webm`);
                        fs.renameSync(videoPath, newVideoPath);
                        console.log(`Saved account video record to: ${newVideoPath}`);
                    }
                }
                accountIndex++;
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
        const page = currentSession.page;
        const video = page.video();
        await currentSession.browser.close();
        if (video) {
            const videoPath = await video.path().catch(() => null);
            if (videoPath && fs.existsSync(videoPath)) {
                const newVideoPath = path.join('wallpapers', `account_${accountIndex}_record.webm`);
                fs.renameSync(videoPath, newVideoPath);
                console.log(`Saved account video record to: ${newVideoPath}`);
            }
        }
        console.log('\nAll prompts processed. Browser closed.');
    }
})();

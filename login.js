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
    
    // Launch a separate browser for mailwave to avoid session fingerprint association and background tab throttling
    console.log('Launching separate browser process for mailwave.dev...');
    const mailwaveBrowser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    const mailwaveContext = await mailwaveBrowser.newContext({
        viewport: { width: 1280, height: 800 }
    });
    

    const mailwavePage = await mailwaveContext.newPage();
    mailwavePage.setDefaultTimeout(30000);
    mailwavePage.setDefaultNavigationTimeout(30000);

    let email = '';
    try {
        console.log('Navigating to mailwave.dev to generate temp email...');
        await mailwavePage.goto('https://mailwave.dev/', { waitUntil: 'load', timeout: 30000 });
        
        console.log('Waiting for email address generation...');
        const emailInput = mailwavePage.locator('input#mainEmail');
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });

        // Clean up the initial mailbox once to clear any previous cached session
        console.log('Cleaning up initial session mailbox...');
        const initialDeleteBtn = mailwavePage.locator('button#delete');
        await initialDeleteBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await initialDeleteBtn.click({ force: true, timeout: 2000 }).catch(() => {});
        await mailwavePage.waitForTimeout(3000);
        
        let attempts = 0;
        while (attempts < 15) {
            email = await emailInput.inputValue();
            if (email && email !== 'landing' && email.includes('@')) {
                if (email.toLowerCase().includes('.edu')) {
                    break;
                }
                console.log(`Generated email "${email}" is not an .edu domain (OpenAI blocks standard disposable domains). Requesting a new address...`);
                const deleteBtn = mailwavePage.locator('button#delete');
                await deleteBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
                await deleteBtn.click({ force: true, timeout: 2000 }).catch(() => {});
                await mailwavePage.waitForTimeout(3000);
            } else {
                await mailwavePage.waitForTimeout(1000);
            }
            attempts++;
        }
        
        if (!email || email === 'landing' || !email.toLowerCase().includes('.edu')) {
            throw new Error('Failed to generate a valid .edu email address on mailwave.dev');
        }
        console.log(`Successfully generated .edu email: ${email}`);
    } catch (err) {
        await mailwaveBrowser.close().catch(() => {});
        throw err;
    }

    // Now launch the main ChatGPT browser
    console.log('Launching main browser process for ChatGPT...');
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        recordVideo: {
            dir: 'wallpapers/',
            size: { width: 1280, height: 800 }
        }
    });


    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    try {
        console.log('Navigating to ChatGPT...');
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

        const loginBtn = page.locator('[data-testid="login-button"]');
        await loginBtn.waitFor({ state: 'visible', timeout: 15000 });
        await loginBtn.click();

        const chatgptEmailInput = page.locator('input#email');
        await chatgptEmailInput.waitFor({ state: 'visible', timeout: 15000 });

        console.log(`Entering registration email: ${email}`);
        await chatgptEmailInput.fill(email);
        await chatgptEmailInput.press('Enter');

        // Fallback: If still on same screen, click Continue button directly
        await page.waitForTimeout(2000);
        const continueBtn = page.locator('button[type="submit"]:has-text("Continue"), button:has-text("Continue")');
        if (await continueBtn.count() > 0 && await continueBtn.first().isVisible()) {
            console.log('Clicking the Continue button directly...');
            await continueBtn.first().click().catch(() => {});
        }

        console.log('Waiting for verification page (waiting for code input)...');
        const codeInput = page.locator('input[name="code"], input[placeholder="Code"], input[id$="-code"]');
        await codeInput.waitFor({ state: 'visible', timeout: 30000 });

        // Retrieve OTP using the mailwave browser
        console.log('Checking mailwave.dev for OTP...');
        const mailboxItem = mailwavePage.locator('#mailbox .mailbox-item');
        
        let emailArrived = false;
        let otp = '';
        for (let attempt = 1; attempt <= 30; attempt++) {
            if (await mailboxItem.count() > 0) {
                const item = mailboxItem.first();
                const itemText = await item.textContent().catch(() => '');
                if (itemText.includes('ChatGPT') || itemText.includes('verification code')) {
                    console.log('Verification email found in list! Opening message...');
                    await item.click({ force: true, timeout: 2000 }).catch(() => {});
                    
                    // Wait for the message body iframe to be attached
                    const iframeLocator = mailwavePage.locator('iframe#myContent');
                    await iframeLocator.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
                    await mailwavePage.waitForTimeout(2000);

                    const iframe = mailwavePage.frameLocator('iframe#myContent');
                    
                    // Find elements containing only the 6-digit OTP code to avoid matching CSS hex colors inside the iframe body
                    const otpElements = await iframe.locator('p, span, div').all();
                    for (const el of otpElements) {
                        const text = (await el.textContent() || '').trim();
                        if (/^\d{6}$/.test(text)) {
                            otp = text;
                            break;
                        }
                    }

                    if (otp) {
                        emailArrived = true;
                        break;
                    } else {
                        console.log('Could not find 6-digit OTP code in the email iframe content. Navigating back...');
                        await mailwavePage.goto('https://mailwave.dev/', { waitUntil: 'load', timeout: 30000 });
                        await mailwavePage.waitForTimeout(2000);
                    }
                }
            }
            console.log(`Email not arrived yet (attempt ${attempt}/30). Waiting...`);
            await mailwavePage.waitForTimeout(5000);
        }

        if (!emailArrived || !otp) {
            throw new Error('Verification email from ChatGPT did not arrive on mailwave.dev or was invalid.');
        }

        console.log(`Successfully retrieved OTP: ${otp}`);

        // Close the mailwave browser as we are done with it
        await mailwaveBrowser.close().catch(() => {});

        // Bring the ChatGPT page to the front to ensure it is focused and not throttled
        console.log('Bringing ChatGPT tab to front...');
        await page.bringToFront();
        await page.waitForTimeout(1000);

        // Fill in OTP on ChatGPT
        console.log(`Entering OTP code: ${otp} on ChatGPT...`);
        await codeInput.focus();
        await codeInput.fill(otp);

        // Wait a brief moment to see if it submits automatically and navigates
        await page.waitForTimeout(3000);

        // If nameInput is not visible yet, try to find and click the submit button
        const nameInput = page.locator('input[name="name"], input[placeholder="Full name"]');
        if (await nameInput.count() === 0 || !(await nameInput.first().isVisible())) {
            console.log('Form did not auto-submit. Locating and clicking submit/continue button...');
            const submitBtn = page.locator('button[type="submit"][value="validate"], button:has-text("Continue")');
            if (await submitBtn.count() > 0 && await submitBtn.first().isVisible()) {
                await submitBtn.first().click().catch(err => console.log('Submit button click ignored:', err.message));
            }
        }

        // Wait for profile setup form (About You) page
        console.log('Waiting for Profile Setup (About You) page to load...');
        await nameInput.waitFor({ state: 'visible', timeout: 30000 });

        console.log('Filling Profile Info (Name & Age)...');
        await nameInput.fill('jahid hasan');

        const ageInput = page.locator('input[name="age"], input[placeholder="Age"]');
        await ageInput.waitFor({ state: 'visible', timeout: 15000 });
        await ageInput.fill('30');

        console.log('Submitting Profile Info...');
        const finishBtn = page.locator('button[type="submit"]:has-text("Finish creating account"), button:has-text("Finish creating account")');
        await finishBtn.click();

        console.log('Waiting for redirect back to ChatGPT...');
        await page.waitForURL('**/chatgpt.com/**', { waitUntil: 'domcontentloaded', timeout: 0 });

        await page.waitForTimeout(5000);

        const allSetBtn = page.locator('button.btn-primary:has-text("Continue"), button:has-text("Continue")');
        if (await allSetBtn.count() > 0) {
            console.log('"You\'re all set" button found. Clicking it...');
            await allSetBtn.first().click();
            await page.waitForTimeout(2000);
        }

        console.log('New account session successfully created and logged in.');

        const emailsFilePath = path.join(__dirname, 'emails.txt');
        fs.appendFileSync(emailsFilePath, `${email}\n`, 'utf8');
        console.log(`Saved registered email: ${email} to ${emailsFilePath}`);

        return { browser, page };

    } catch (error) {
        console.error('An error occurred during account creation:', error);
        await page.screenshot({ path: 'wallpapers/error_signup.png', fullPage: true });
        const video = page.video();
        await browser.close().catch(() => {});
        await mailwaveBrowser.close().catch(() => {});
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
                await currentSession.browser.close().catch(() => {});
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
            await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

            console.log('Locating prompt input text area (#prompt-textarea)...');
            const promptArea = page.locator('#prompt-textarea');
            await promptArea.waitFor({ state: 'visible', timeout: 30000 });

            // Format the prompt with the required 9:16 aspect ratio instruction prefix if not already present
            let finalPrompt = prompt;
            if (!finalPrompt.toLowerCase().includes('9:16') && !finalPrompt.toLowerCase().includes('ratio')) {
                finalPrompt = `Create image a wallpaper 9:16 ratio of ${prompt}`;
            }

            console.log(`Focusing and typing final prompt: "${finalPrompt}"`);
            await promptArea.click();
            await page.keyboard.type(finalPrompt);
            await page.waitForTimeout(1000);

            console.log('Locating send button...');
            const sendBtn = page.locator('[data-testid="send-button"], #composer-submit-button');
            await sendBtn.waitFor({ state: 'visible', timeout: 0 });

            console.log('Clicking the send button...');
            await sendBtn.click();

            console.log('Waiting for image generation to complete (waiting for Share button)...');
            const shareBtn = page.locator('button[aria-label="Share this image"]').first();
            await shareBtn.waitFor({ state: 'visible', timeout: 120000 });

            console.log('Image generated successfully. Hovering and clicking Share...');
            const imageContainer = page.locator('.group\\/imagegen-image').first();
            if (await imageContainer.count() > 0) {
                await imageContainer.hover().catch(() => {});
            }
            await shareBtn.click();

            console.log('Waiting for share modal to load...');
            const downloadBtn = page.locator('button:has-text("Download")').first();
            await downloadBtn.waitFor({ state: 'visible', timeout: 30000 });

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
        await currentSession.browser.close().catch(() => {});
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

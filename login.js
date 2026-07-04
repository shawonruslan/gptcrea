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

function cleanHtml(html) {
    if (!html) return '';
    let clean = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
    clean = clean.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
    clean = clean.replace(/<!--[\s\S]*?-->/g, ' ');
    clean = clean.replace(/<[^>]+>/g, ' ');
    clean = clean.replace(/&nbsp;/gi, ' ')
                 .replace(/&amp;/gi, '&')
                 .replace(/&lt;/gi, '<')
                 .replace(/&gt;/gi, '>');
    return clean.replace(/\s+/g, ' ').trim();
}

async function dismissOnboarding(page) {
    console.log('Checking for onboarding screens or modals to dismiss...');
    // We will attempt to dismiss up to 5 consecutive onboarding screens/steps
    for (let step = 0; step < 5; step++) {
        let foundElement = null;
        let actionName = '';
        
        const locators = [
            { name: 'Skip', locator: page.locator('button:has-text("Skip"), [role="button"]:has-text("Skip"), a:has-text("Skip"), span:has-text("Skip")') },
            { name: 'Continue/Done/Got it', locator: page.locator('button:has-text("Continue"), [role="button"]:has-text("Continue"), button:has-text("Done"), button:has-text("Got it")') },
            { name: 'Let\'s go', locator: page.locator('button:has-text("Okay, let\'s go"), button:has-text("Let\'s go")') },
            { name: 'Close button', locator: page.locator('button[data-testid="close-button"], [aria-label="Close"]') }
        ];

        // Poll for visibility of any of these elements
        for (let attempt = 0; attempt < 8; attempt++) { // 8 * 500ms = 4 seconds max wait per step
            for (const item of locators) {
                if (await item.locator.count() > 0 && await item.locator.first().isVisible()) {
                    foundElement = item.locator.first();
                    actionName = item.name;
                    break;
                }
            }
            if (foundElement) break;
            await page.waitForTimeout(500);
        }

        if (foundElement) {
            console.log(`Found "${actionName}" onboarding button. Clicking it...`);
            await foundElement.click();
            // Wait 1.5 seconds for the transition after clicking
            await page.waitForTimeout(1500);
        } else {
            console.log('No onboarding screens or modals visible.');
            break;
        }
    }
}


async function createNewSession() {
    console.log('\n--- Creating New Browser Session and Registering New Account ---');

    let email = '';
    let uuid = '';
    try {
        console.log('Fetching active EduMails domains...');
        const domainsRes = await fetch('https://api.edu-mails.com/api/domains');
        const domainsJson = await domainsRes.json();
        if (domainsJson.status !== 'success' || !domainsJson.data || !domainsJson.data.domains || domainsJson.data.domains.length === 0) {
            throw new Error('Failed to fetch domains from EduMails API: ' + JSON.stringify(domainsJson));
        }

        const domains = domainsJson.data.domains;
        const selectedDomain = domains[Math.floor(Math.random() * domains.length)];
        const alias = generateRandomString(10).toLowerCase();

        console.log(`Generating EduMails temp email for custom alias: ${alias} on domain: ${selectedDomain.name} (id: ${selectedDomain.id})...`);
        const genRes = await fetch('https://api.edu-mails.com/api/emails/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'custom',
                alias: alias,
                domain_id: selectedDomain.id
            })
        });
        const genJson = await genRes.json();
        if (genJson.status !== 'success' || !genJson.data || !genJson.data.email) {
            throw new Error('Failed to generate email via EduMails: ' + JSON.stringify(genJson));
        }
        email = genJson.data.email.address;
        uuid = genJson.data.email.uuid;
        console.log(`Successfully generated email: ${email} (uuid: ${uuid})`);
    } catch (err) {
        throw err;
    }

    // Now launch the main ChatGPT browser
    console.log('Launching main browser process for ChatGPT...');
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    try {
        console.log('Navigating to ChatGPT...');
        await page.goto('https://chatgpt.com/', { waitUntil: 'load' });

        const loginBtn = page.locator('[data-testid="login-button"]');
        await loginBtn.waitFor({ state: 'visible' });
        await loginBtn.click();

        const chatgptEmailInput = page.locator('input#email');
        await chatgptEmailInput.waitFor({ state: 'visible' });

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
        await codeInput.waitFor({ state: 'visible' });

        // Retrieve OTP using EduMails API
        console.log('Checking EduMails inbox for ChatGPT verification email...');
        let otp = null;
        for (let attempt = 1; attempt <= 30; attempt++) {
            try {
                const mailRes = await fetch(`https://api.edu-mails.com/api/emails/${uuid}`);
                const mailJson = await mailRes.json();
                if (mailJson.status === 'success' && mailJson.data && mailJson.data.messages) {
                    const messages = mailJson.data.messages;
                    const relevantMessage = messages.find(msg => 
                        (msg.from && (msg.from.includes('ChatGPT') || msg.from.includes('OpenAI') || msg.from.includes('openai.com'))) ||
                        (msg.subject && (msg.subject.includes('ChatGPT') || msg.subject.includes('verification'))) ||
                        (msg.body && (msg.body.includes('ChatGPT') || msg.body.includes('verification')))
                    );
                    
                    if (relevantMessage) {
                        const cleanedBody = cleanHtml(relevantMessage.body);
                        const contentToSearch = `${relevantMessage.subject || ''} ${cleanedBody}`;
                        const otpMatch = contentToSearch.match(/\b\d{6}\b/);
                        if (otpMatch) {
                            otp = otpMatch[0];
                            break;
                        }
                    }
                }
            } catch (err) {
                console.error(`Error checking inbox (attempt ${attempt}/30):`, err.message);
            }
            console.log(`Email not arrived yet or OTP not found (attempt ${attempt}/30). Waiting 5 seconds...`);
            await page.waitForTimeout(5000);
        }

        if (!otp) {
            throw new Error('Verification email from ChatGPT did not arrive or OTP could not be extracted.');
        }
        console.log(`Successfully retrieved OTP: ${otp}`);

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
        if (await nameInput.count() === 0 || !(await nameInput.isVisible())) {
            console.log('Form did not auto-submit. Locating and clicking submit/continue button...');
            const submitBtn = page.locator('button[type="submit"][value="validate"], button:has-text("Continue")');
            if (await submitBtn.count() > 0 && await submitBtn.isVisible()) {
                await submitBtn.click().catch(err => console.log('Submit button click ignored:', err.message));
            }
        }

        // Wait for profile setup form (About You) page
        console.log('Waiting for Profile Setup (About You) page to load...');
        await nameInput.waitFor({ state: 'visible' });

        console.log('Filling Profile Info (Name & Age)...');
        await nameInput.fill('jahid hasan');

        const ageInput = page.locator('input[name="age"], input[placeholder="Age"]');
        await ageInput.waitFor({ state: 'visible' });
        await ageInput.fill('30');

        console.log('Submitting Profile Info...');
        const finishBtn = page.locator('button[type="submit"]:has-text("Finish creating account"), button:has-text("Finish creating account")');
        await finishBtn.click();

        console.log('Waiting for redirect back to ChatGPT...');
        await page.waitForURL('**/chatgpt.com/**', { waitUntil: 'domcontentloaded' });

        await dismissOnboarding(page);

        console.log('New account session successfully created and logged in.');

        const emailsFilePath = path.join(__dirname, 'emails.txt');
        fs.appendFileSync(emailsFilePath, `${email}\n`, 'utf8');
        console.log(`Saved registered email: ${email} to ${emailsFilePath}`);

        return { browser, page };

    } catch (error) {
        console.error('An error occurred during account creation:', error);
        try {
            console.error('Current Page URL:', page.url());
            console.error('Current Page Title:', await page.title());
            const bodyText = await page.innerText('body').catch(() => '');
            console.error('Page Body Text Snippet (first 800 chars):', bodyText.slice(0, 800));
        } catch (diagErr) {
            console.error('Failed to capture diagnostic page details:', diagErr.message);
        }
        await page.screenshot({ path: 'wallpapers/error_signup.png', fullPage: true });
        await browser.close().catch(() => { });
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
                await currentSession.browser.close().catch(() => { });
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
            await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });

            await dismissOnboarding(page);

            console.log('Locating prompt input text area (#prompt-textarea)...');
            const promptArea = page.locator('#prompt-textarea');
            await promptArea.waitFor({ state: 'visible' });

            console.log('Focusing and typing the image prompt...');
            await promptArea.click();
            let finalPrompt = prompt;
            if (!prompt.includes('9:16') && !prompt.toLowerCase().includes('aspect ratio')) {
                finalPrompt = `Create a vertical 9:16 aspect ratio wallpaper of: ${prompt}`;
            }
            console.log(`Typing formatted prompt: "${finalPrompt}"`);
            await page.keyboard.type(finalPrompt);
            await page.waitForTimeout(1000);

            console.log('Locating send button...');
            const sendBtn = page.locator('[data-testid="send-button"], #composer-submit-button');
            await sendBtn.waitFor({ state: 'visible' });

            console.log('Clicking the send button...');
            await sendBtn.click();

            console.log('Waiting for image generation to complete (waiting for Share button)...');
            const shareBtn = page.locator('button[aria-label="Share this image"]').first();
            await shareBtn.waitFor({ state: 'visible' });

            console.log('Image generated successfully. Hovering and clicking Share...');
            const imageContainer = page.locator('.group\\/imagegen-image').first();
            if (await imageContainer.count() > 0) {
                await imageContainer.hover().catch(() => { });
            }
            await shareBtn.click();

            console.log('Waiting for share modal to load...');
            const downloadBtn = page.locator('button:has-text("Download")').first();
            await downloadBtn.waitFor({ state: 'visible' });

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
                await closeBtn.click().catch(() => { });
            }

            generationsOnCurrentAccount++;
            console.log(`Generations on current account: ${generationsOnCurrentAccount}/5`);

        } catch (error) {
            console.error(`Error processing prompt ${i + 1}:`, error);
            await page.screenshot({ path: `wallpapers/error_prompt_${i + 1}.png`, fullPage: true });
        }
    }
    if (currentSession) {
        await currentSession.browser.close().catch(() => { });
        console.log('\nAll prompts processed. Browser closed.');
    }
})();

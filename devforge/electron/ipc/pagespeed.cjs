'use strict';

const { ipcMain } = require('electron');

module.exports = function registerPagespeedHandlers(_win) {

    ipcMain.handle('run-lighthouse', async (_event, { url, strategy }) => {
        let chrome;

        if (typeof performance !== 'undefined' && performance.clearMarks) {
            performance.clearMarks();
            performance.clearMeasures();
        }

        try {
            const lighthouse = (await import('lighthouse')).default;
            const { launch } = await import('chrome-launcher');
            const { parseToPageSpeedInsightResult, buildErrorPageSpeedInsightResult } = await import('../utils/pageSpeedAuditParser.js');

            chrome = await launch({
                chromeFlags: [
                    '--headless',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--disable-extensions',
                    '--no-first-run',
                    '--no-default-browser-check',
                ],
            });

            const result = await lighthouse(url, {
                port: chrome.port,
                output: 'json',
                logLevel: 'error',
                formFactor: strategy,
                screenEmulation: {
                    mobile: strategy === 'mobile',
                    width: strategy === 'mobile' ? 360 : 1350,
                    height: strategy === 'mobile' ? 640 : 940,
                },
                onlyCategories: ['performance'],
                maxWaitForLoad: 60000,
                maxWaitForFcp: 30000,
                skipAudits: [
                    'screenshot-thumbnails',
                    'final-screenshot',
                    'full-page-screenshot',
                ],
            });

            if (!result) throw new Error('Lighthouse failed to produce a result.');
            if (result.lhr.runtimeError) throw new Error(result.lhr.runtimeError.message);

            return parseToPageSpeedInsightResult(
                url,
                result.lhr.audits,
                result.lhr.runWarnings?.[0],
            );
        } catch (err) {
            console.error('Lighthouse Error:', err.message);
            return buildErrorPageSpeedInsightResult(url, err.message);
        } finally {
            if (chrome) {
                try { chrome.kill(); } catch { /* ignore cleanup errors */ }
            }
        }
    });
};

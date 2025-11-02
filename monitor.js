const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

const CONFIG = {
    // Use Helius or another premium RPC for production
    RPC_ENDPOINT: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
    RPC_WS_ENDPOINT: process.env.RPC_WS_ENDPOINT || 'wss://api.mainnet-beta.solana.com',

    // Program IDs to monitor
    RAYDIUM_AUTHORITY_V4: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
    RAYDIUM_AMM_PROGRAM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    RAYDIUM_LAUNCHPAD: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
    PUMP_FUN_PROGRAM: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

    // Safety thresholds
    MIN_LIQUIDITY_SOL: 1, // Minimum 1 SOL liquidity
    MAX_TOP_HOLDER_PERCENT: 50, // Top holder shouldn't have more than 50%
    MIN_HOLDERS: 10, // Minimum number of holders

    // Bitquery API (if using)
    BITQUERY_API_KEY: process.env.BITQUERY_API_KEY || '',
};

class TokenLaunchMonitor {
    constructor() {
        this.connection = new Connection(CONFIG.RPC_ENDPOINT, {
            commitment: 'confirmed',
            wsEndpoint: CONFIG.RPC_WS_ENDPOINT,
        });
        this.monitoredTokens = new Map();
    }

    async start() {
        console.log('🚀 Starting Token Launch Monitor...');
        console.log(`📡 Connected to: ${CONFIG.RPC_ENDPOINT}`);
        console.log('👀 Monitoring for new launches...\n');

        // Method 1: Monitor Raydium program logs
        await this.monitorRaydiumLaunches();

        // Method 2: Use Bitquery WebSocket (if API key available)
        if (CONFIG.BITQUERY_API_KEY) {
            await this.monitorWithBitquery();
        }
    }

    // Monitor Raydium launches via program logs subscription
    async monitorRaydiumLaunches() {
        try {
            const subscriptionId = this.connection.onLogs(
                new PublicKey(CONFIG.RAYDIUM_AMM_PROGRAM),
                async (logs, context) => {
                    // Check if this is a pool initialization
                    if (this.isPoolInitialization(logs)) {
                        await this.handleNewLaunch(logs, context, 'Raydium');
                    }
                },
                'confirmed'
            );
            console.log(`✅ Subscribed to Raydium AMM (ID: ${subscriptionId})`);

            // Subscribe to Raydium LaunchPad
            const launchpadSubId = this.connection.onLogs(
                new PublicKey(CONFIG.RAYDIUM_LAUNCHPAD),
                async (logs, context) => {
                    if (this.isPoolInitialization(logs)) {
                        await this.handleNewLaunch(logs, context, 'Raydium LaunchPad');
                    }
                },
                'confirmed'
            );

            console.log(`✅ Subscribed to Raydium LaunchPad (ID: ${launchpadSubId})\n`);
        } catch (error) {
            console.error('❌ Error setting up Raydium monitoring:', error.message);
        }
    }

    /**
   * Check if logs indicate a pool initialization
   */
    isPoolInitialization(logs) {
        const logStr = logs.logs.join(' ').toLowerCase();
        return logStr.includes('initialize') ||
            logStr.includes('init') ||
            logStr.includes('create');
    }

    async handleNewLaunch(logs, context, platform) {
        const signature = logs.signature;

        console.log(`\n${'='.repeat(80)}`);
        console.log(`🆕 NEW LAUNCH DETECTED on ${platform}`);
        console.log(`Signature: ${signature}`);
        console.log(`Slot: ${context.slot}`);  // ✅ Fixed!
        console.log(`${'='.repeat(80)}\n`);

        try {
            // Get full transaction details
            const txDetails = await this.getTransactionDetails(signature);

            if (!txDetails) {
                console.log('⚠️  Could not fetch transaction details\n');
                return;
            }

            // Extract token information
            const tokenInfo = await this.extractTokenInfo(txDetails);

            if (!tokenInfo) {
                console.log('⚠️  Could not extract token information\n');
                return;
            }

            console.log('📋 Token Information:');
            console.log(`   Mint: ${tokenInfo.mint}`);
            console.log(`   Pool: ${tokenInfo.pool || 'Unknown'}`);
            console.log(`   Creator: ${tokenInfo.creator || 'Unknown'}\n`);

            // Run safety checks
            const safetyResults = await this.runSafetyChecks(tokenInfo);

            // Display results
            this.displaySafetyResults(tokenInfo, safetyResults);

            // Store for analysis
            this.monitoredTokens.set(tokenInfo.mint, {
                ...tokenInfo,
                safetyResults,
                detectedAt: new Date(),
                platform,
            });

        } catch (error) {
            console.error(`❌ Error processing launch: ${error.message}\n`);
        }
    }

    /**
   * Get full transaction details
   */
    async getTransactionDetails(signature) {
        try {
            const tx = await this.connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
            });
            return tx;
        } catch (error) {
            console.error(`Error fetching transaction: ${error.message}`);
            return null;
        }
    }

    /**
   * Extract token mint address and other info from transaction
   */
    async extractTokenInfo(tx) {
        try {
            const accountKeys = tx.transaction.message.getAccountKeys();
            const accounts = accountKeys.staticAccountKeys;

            // Look for token mint in the accounts
            // This is simplified - in production you'd parse the instruction data more carefully
            let mint = null;
            let pool = null;
            let creator = null;

            // The signer is typically the creator
            if (accounts && accounts.length > 0) {
                creator = accounts[0].toString();

                // Try to find mint address (usually one of the accounts)
                for (let i = 0; i < accounts.length; i++) {
                    const account = accounts[i];
                    // Basic heuristic: check account info
                    try {
                        const accountInfo = await this.connection.getAccountInfo(account);
                        if (accountInfo && accountInfo.owner.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                            // Might be a token account or mint
                            if (accountInfo.data.length === 82) { // Mint account size
                                mint = account.toString();
                            }
                        }
                    } catch (e) {
                        // Skip this account
                    }
                }
            }

            return mint ? { mint, pool, creator } : null;
        } catch (error) {
            console.error(`Error extracting token info: ${error.message}`);
            return null;
        }
    }


    /**
     * Run all safety checks on the token
     */
    async runSafetyChecks(tokenInfo) {
        console.log('🔍 Running Safety Checks...\n');

        const results = {
            mintAuthority: { status: 'checking', message: '' },
            freezeAuthority: { status: 'checking', message: '' },
            metadata: { status: 'checking', message: '' },
            liquidity: { status: 'checking', message: '' },
            topHolders: { status: 'checking', message: '' },
            overallScore: 0,
            recommendation: 'UNKNOWN',
        };

        try {
            // Run checks in parallel
            await Promise.allSettled([
                this.checkMintAuthority(tokenInfo, results),
                this.checkFreezeAuthority(tokenInfo, results),
                this.checkMetadata(tokenInfo, results),
                this.checkLiquidity(tokenInfo, results),
                this.checkTopHolders(tokenInfo, results),
            ]);

            // Calculate overall score
            results.overallScore = this.calculateScore(results);
            results.recommendation = this.getRecommendation(results.overallScore);

        } catch (error) {
            console.error(`Error running safety checks: ${error.message}`);
        }

        return results;
    }

    /**
    * Check if mint authority is revoked
    */
    async checkMintAuthority(tokenInfo, results) {
        try {
            const mintPubkey = new PublicKey(tokenInfo.mint);
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);

            if (mintInfo && mintInfo.value && mintInfo.value.data.parsed) {
                const mintAuthority = mintInfo.value.data.parsed.info.mintAuthority;

                if (mintAuthority === null) {
                    results.mintAuthority = {
                        status: 'pass',
                        message: '✅ Mint authority revoked (good)',
                    };
                } else {
                    results.mintAuthority = {
                        status: 'fail',
                        message: `⚠️  Mint authority NOT revoked (can mint infinite tokens)`,
                        authority: mintAuthority,
                    };
                }
            }
        } catch (error) {
            results.mintAuthority = {
                status: 'error',
                message: `❌ Error checking mint authority: ${error.message}`,
            };
        }
    }

    /**
  * Check if freeze authority is revoked
  */
    async checkFreezeAuthority(tokenInfo, results) {
        try {
            const mintPubkey = new PublicKey(tokenInfo.mint);
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);

            if (mintInfo && mintInfo.value && mintInfo.value.data.parsed) {
                const freezeAuthority = mintInfo.value.data.parsed.info.freezeAuthority;

                if (freezeAuthority === null) {
                    results.freezeAuthority = {
                        status: 'pass',
                        message: '✅ Freeze authority revoked (good)',
                    };
                } else {
                    results.freezeAuthority = {
                        status: 'fail',
                        message: `⚠️  Freeze authority NOT revoked (can freeze your tokens)`,
                        authority: freezeAuthority,
                    };
                }
            }
        } catch (error) {
            results.freezeAuthority = {
                status: 'error',
                message: `❌ Error checking freeze authority: ${error.message}`,
            };
        }
    }
    /**
   * Check token metadata
   */
    async checkMetadata(tokenInfo, results) {
        try {
            // Try to get token metadata from Metaplex
            const TOKEN_METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
            const mintPubkey = new PublicKey(tokenInfo.mint);

            const [metadataPDA] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('metadata'),
                    TOKEN_METADATA_PROGRAM.toBuffer(),
                    mintPubkey.toBuffer(),
                ],
                TOKEN_METADATA_PROGRAM
            );

            const metadataAccount = await this.connection.getAccountInfo(metadataPDA);

            if (metadataAccount) {
                results.metadata = {
                    status: 'pass',
                    message: '✅ Metadata found',
                };
            } else {
                results.metadata = {
                    status: 'warning',
                    message: '⚠️  No metadata found (unusual)',
                };
            }
        } catch (error) {
            results.metadata = {
                status: 'error',
                message: `❌ Error checking metadata: ${error.message}`,
            };
        }
    }


    /**
 * Check initial liquidity
 */
    async checkLiquidity(tokenInfo, results) {
        try {
            // This is simplified - would need pool address to check actual liquidity
            results.liquidity = {
                status: 'unknown',
                message: '⚠️  Liquidity check requires pool address (not yet implemented)',
            };
        } catch (error) {
            results.liquidity = {
                status: 'error',
                message: `❌ Error checking liquidity: ${error.message}`,
            };
        }
    }


    /**
 * Check top holder distribution
 */
    async checkTopHolders(tokenInfo, results) {
        try {
            const mintPubkey = new PublicKey(tokenInfo.mint);
            const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);

            if (largestAccounts && largestAccounts.value.length > 0) {
                const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
                const supply = mintInfo?.value?.data?.parsed?.info?.supply || 0;

                const topHolder = largestAccounts.value[0];
                const topHolderPercent = (topHolder.amount / supply) * 100;

                if (topHolderPercent > CONFIG.MAX_TOP_HOLDER_PERCENT) {
                    results.topHolders = {
                        status: 'fail',
                        message: `⚠️  Top holder has ${topHolderPercent.toFixed(2)}% (risky concentration)`,
                        percentage: topHolderPercent,
                    };
                } else {
                    results.topHolders = {
                        status: 'pass',
                        message: `✅ Top holder has ${topHolderPercent.toFixed(2)}% (acceptable)`,
                        percentage: topHolderPercent,
                    };
                }
            }
        } catch (error) {
            results.topHolders = {
                status: 'error',
                message: `❌ Error checking top holders: ${error.message}`,
            };
        }
    }

    /**
   * Calculate overall safety score (0-100)
   */
    calculateScore(results) {
        let score = 0;
        const weights = {
            mintAuthority: 30,
            freezeAuthority: 30,
            metadata: 10,
            liquidity: 15,
            topHolders: 15,
        };

        for (const [check, weight] of Object.entries(weights)) {
            const result = results[check];
            if (result.status === 'pass') {
                score += weight;
            } else if (result.status === 'warning') {
                score += weight * 0.5;
            }
            // fail or error = 0 points
        }

        return Math.round(score);
    }

    /**
     * Get recommendation based on score
     */
    getRecommendation(score) {
        if (score >= 80) return '🟢 SAFE - Good fundamentals';
        if (score >= 60) return '🟡 CAUTION - Some risks present';
        if (score >= 40) return '🟠 RISKY - Multiple red flags';
        return '🔴 DANGER - High risk, likely scam';
    }

    /**
   * Display safety check results
   */
    displaySafetyResults(tokenInfo, results) {
        console.log('📊 SAFETY CHECK RESULTS:');
        console.log('─'.repeat(80));

        console.log(`\n1. Mint Authority:     ${results.mintAuthority.message}`);
        console.log(`2. Freeze Authority:   ${results.freezeAuthority.message}`);
        console.log(`3. Metadata:           ${results.metadata.message}`);
        console.log(`4. Liquidity:          ${results.liquidity.message}`);
        console.log(`5. Top Holders:        ${results.topHolders.message}`);

        console.log('\n' + '─'.repeat(80));
        console.log(`\n🎯 Overall Score: ${results.overallScore}/100`);
        console.log(`📌 Recommendation: ${results.recommendation}`);
        console.log('\n' + '='.repeat(80) + '\n');
    }

    /**
     * Monitor using Bitquery WebSocket (alternative method)
     */
    async monitorWithBitquery() {
        console.log('📡 Bitquery monitoring not yet implemented');
        console.log('   (Requires Bitquery API key and GraphQL subscription setup)\n');
    }

    /**
   * Get statistics
   */
    getStats() {
        return {
            totalDetected: this.monitoredTokens.size,
            tokens: Array.from(this.monitoredTokens.entries()).map(([mint, data]) => ({
                mint,
                score: data.safetyResults.overallScore,
                recommendation: data.safetyResults.recommendation,
                platform: data.platform,
                detectedAt: data.detectedAt,
            })),
        };
    }
    /**
     * Get statistics
     */
    getStats() {
        return {
            totalDetected: this.monitoredTokens.size,
            tokens: Array.from(this.monitoredTokens.entries()).map(([mint, data]) => ({
                mint,
                score: data.safetyResults.overallScore,
                recommendation: data.safetyResults.recommendation,
                platform: data.platform,
                detectedAt: data.detectedAt,
            })),
        };
    }
}

// Main execution
async function main() {
    const monitor = new TokenLaunchMonitor();

    // Start monitoring
    await monitor.start();

    // Display stats every 5 minutes
    setInterval(() => {
        const stats = monitor.getStats();
        console.log('\n📈 MONITORING STATISTICS:');
        console.log(`   Total tokens detected: ${stats.totalDetected}`);
        console.log(`   Time: ${new Date().toLocaleString()}\n`);
    }, 5 * 60 * 1000);

    // Keep process running
    process.on('SIGINT', () => {
        console.log('\n\n👋 Shutting down monitor...');
        const stats = monitor.getStats();
        console.log(`\nFinal stats: ${stats.totalDetected} tokens detected`);
        process.exit(0);
    });
}

// Export for use as module
module.exports = { TokenLaunchMonitor };

// Run if executed directly
if (require.main === module) {
    main().catch(console.error);
}










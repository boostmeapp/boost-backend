#!/usr/bin/env ts-node
/**
 * Check platform and connected account balances
 *
 * Usage:
 *   npm run script:check-balance
 *   npm run script:check-balance -- --account acct_xxx
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

async function checkBalance(accountId?: string) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    console.error('❌ STRIPE_SECRET_KEY not found in environment variables');
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2025-11-17.clover'
  });

  try {
    // Check platform balance
    console.log('\n💰 PLATFORM BALANCE');
    console.log('='.repeat(60));
    const balance = await stripe.balance.retrieve();

    console.log('\nAvailable:');
    balance.available.forEach((b) => {
      console.log(`   ${b.currency.toUpperCase()}: ${(b.amount / 100).toFixed(2)}`);
    });

    console.log('\nPending:');
    balance.pending.forEach((b) => {
      console.log(`   ${b.currency.toUpperCase()}: ${(b.amount / 100).toFixed(2)}`);
    });

    // Check connected account balance if provided
    if (accountId) {
      console.log('\n💼 CONNECTED ACCOUNT BALANCE');
      console.log('='.repeat(60));
      console.log(`Account: ${accountId}\n`);

      const connectedBalance = await stripe.balance.retrieve({
        stripeAccount: accountId,
      });

      console.log('Available:');
      connectedBalance.available.forEach((b) => {
        console.log(`   ${b.currency.toUpperCase()}: ${(b.amount / 100).toFixed(2)}`);
      });

      console.log('\nPending:');
      connectedBalance.pending.forEach((b) => {
        console.log(`   ${b.currency.toUpperCase()}: ${(b.amount / 100).toFixed(2)}`);
      });
    }

    console.log('\n' + '='.repeat(60));

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
let accountId: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--account' && args[i + 1]) {
    accountId = args[i + 1];
    i++;
  }
}

checkBalance(accountId);

#!/usr/bin/env ts-node
/**
 * Simple transfer script that directly transfers funds without account verification
 * Use this if you're getting "Only Stripe Connect platforms" error
 *
 * Usage:
 *   npm run script:simple-transfer -- --account acct_xxx --amount 100
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

async function simpleTransfer(accountId: string, amount: number) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    console.error('❌ STRIPE_SECRET_KEY not found');
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2025-11-17.clover'
  });

  try {
    console.log('\n🚀 Starting transfer...');
    console.log(`   Account: ${accountId}`);
    console.log(`   Amount: $${amount.toFixed(2)}`);

    // Check platform balance
    console.log('\n💰 Checking platform balance...');
    const balance = await stripe.balance.retrieve();
    const availableUSD = balance.available.find((b) => b.currency === 'usd');
    const currentBalance = availableUSD ? availableUSD.amount / 100 : 0;
    console.log(`   Available: $${currentBalance.toFixed(2)}`);

    if (currentBalance < amount) {
      console.error(`\n❌ Insufficient balance!`);
      console.error(`   Required: $${amount.toFixed(2)}`);
      console.error(`   Available: $${currentBalance.toFixed(2)}`);
      process.exit(1);
    }

    // Create transfer
    console.log('\n💸 Creating transfer...');
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      destination: accountId,
      description: 'Test transfer for payout',
    });

    console.log(`   ✅ Transfer successful!`);
    console.log(`   Transfer ID: ${transfer.id}`);
    console.log(`   Amount: $${(transfer.amount / 100).toFixed(2)}`);

    // Check connected account balance
    console.log('\n💼 Connected account balance:');
    const connectedBalance = await stripe.balance.retrieve({
      stripeAccount: accountId,
    });
    const connectedAvailableUSD = connectedBalance.available.find((b) => b.currency === 'usd');
    const connectedPendingUSD = connectedBalance.pending.find((b) => b.currency === 'usd');
    console.log(`   Available: $${connectedAvailableUSD ? (connectedAvailableUSD.amount / 100).toFixed(2) : '0.00'}`);
    console.log(`   Pending: $${connectedPendingUSD ? (connectedPendingUSD.amount / 100).toFixed(2) : '0.00'}`);

    console.log('\n✨ Done! You can now test creating a payout via your API.');

  } catch (error) {
    console.error('\n❌ Error:', error.message);

    if (error.message.includes('Only Stripe Connect platforms')) {
      console.error('\n🔧 ACTION REQUIRED:');
      console.error('   You need to enable your account as a Stripe Connect Platform');
      console.error('   Go to: https://dashboard.stripe.com/settings/applications');
      console.error('   Click "Enable Stripe Connect" or "Get Started"');
      console.error('\n   Even though you can CREATE accounts, you cannot TRANSFER');
      console.error('   to them without being a registered Connect platform.');
    }

    process.exit(1);
  }
}

const args = process.argv.slice(2);
let accountId: string | undefined;
let amount = 100;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--account' && args[i + 1]) {
    accountId = args[i + 1];
    i++;
  } else if (args[i] === '--amount' && args[i + 1]) {
    amount = parseFloat(args[i + 1]);
    i++;
  }
}

if (!accountId) {
  console.error('Usage: npm run script:simple-transfer -- --account acct_xxx --amount 100');
  process.exit(1);
}

simpleTransfer(accountId, amount);

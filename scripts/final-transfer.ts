#!/usr/bin/env ts-node
import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env.development'), override: true });

const apiKey = process.env.STRIPE_SECRET_KEY!;
const accountId = process.argv[2] || 'acct_1Sk3fjFD9CeiiaOG';
const amount = parseFloat(process.argv[3] || '100');

const stripe = new Stripe(apiKey, { apiVersion: '2025-11-17.clover' });

async function run() {
  console.log(`\n🚀 Transferring €${amount} to ${accountId}\n`);

  // Check if we have sufficient balance, skip charge creation if we do
  console.log('💰 Checking platform balance...');
  const platformBalance = await stripe.balance.retrieve();
  const eurAvailable = platformBalance.available.find(b => b.currency === 'eur');
  const currentBalance = eurAvailable ? eurAvailable.amount / 100 : 0;
  console.log(`   Available: €${currentBalance.toFixed(2)}\n`);

  if (currentBalance < amount) {
    console.log('💳 Insufficient balance. Use tok_bypassPending for test charges.');
    console.log('   Run: stripe charges create --amount=10000 --currency=eur --source=tok_bypassPending\n');
    process.exit(1);
  }

  // Transfer to connected account
  console.log('💸 Creating transfer...');
  const transfer = await stripe.transfers.create({
    amount: Math.round(amount * 100),
    currency: 'eur',
    destination: accountId,
    description: 'Test payout transfer',
  });
  console.log(`   ✅ Transfer ID: ${transfer.id}`);
  console.log(`   ✅ Amount: €${(transfer.amount / 100).toFixed(2)}\n`);

  // Check balance
  console.log('💰 Connected account balance:');
  const balance = await stripe.balance.retrieve({ stripeAccount: accountId });
  const eur = balance.available.find(b => b.currency === 'eur');
  console.log(`   Available: €${eur ? (eur.amount / 100).toFixed(2) : '0.00'}\n`);

  console.log('✨ Done! Now you can test payouts via your API.\n');
}

run().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});

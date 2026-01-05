#!/usr/bin/env ts-node
/**
 * Diagnostic script to check Stripe configuration
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

async function checkConfig() {
  console.log('\n🔍 Checking Stripe Configuration...\n');

  // Check .env
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  const envKey = process.env.STRIPE_SECRET_KEY;
  console.log('📄 .env file:');
  console.log(`   Key prefix: ${envKey?.substring(0, 20)}...`);

  if (envKey) {
    const stripe = new Stripe(envKey, { apiVersion: '2025-11-17.clover' });
    try {
      const account = await stripe.accounts.retrieve();
      console.log(`   Account ID: ${account.id}`);
      console.log(`   Transfers capability: ${account.capabilities?.transfers || 'not active'}`);

      const accounts = await stripe.accounts.list({ limit: 5 });
      console.log(`   Connected accounts: ${accounts.data.length}`);
      if (accounts.data.length > 0) {
        accounts.data.forEach(acc => {
          console.log(`      - ${acc.id} (${acc.email})`);
        });
      }
    } catch (err) {
      console.log(`   Error: ${err.message}`);
    }
  }

  // Check .env.development
  dotenv.config({ path: path.join(__dirname, '..', '.env.development'), override: true });
  const envDevKey = process.env.STRIPE_SECRET_KEY;
  console.log('\n📄 .env.development file:');
  console.log(`   Key prefix: ${envDevKey?.substring(0, 20)}...`);

  if (envDevKey && envDevKey !== envKey) {
    const stripe = new Stripe(envDevKey, { apiVersion: '2025-11-17.clover' });
    try {
      const account = await stripe.accounts.retrieve();
      console.log(`   Account ID: ${account.id}`);
      console.log(`   Transfers capability: ${account.capabilities?.transfers || 'not active'}`);

      const accounts = await stripe.accounts.list({ limit: 5 });
      console.log(`   Connected accounts: ${accounts.data.length}`);
      if (accounts.data.length > 0) {
        accounts.data.forEach(acc => {
          console.log(`      - ${acc.id} (${acc.email})`);
        });
      }
    } catch (err) {
      console.log(`   Error: ${err.message}`);
    }
  } else if (envDevKey === envKey) {
    console.log('   (Same as .env)');
  }

  console.log('\n✅ Configuration check complete\n');
}

checkConfig().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

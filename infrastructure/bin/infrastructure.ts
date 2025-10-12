#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BorderlessVoiceCommStack } from '../lib/borderless-voice-comm-stack';

const app = new cdk.App();

new BorderlessVoiceCommStack(app, 'BorderlessVoiceCommStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Real-time voice translation infrastructure with WebSocket API Gateway',
});

app.synth();

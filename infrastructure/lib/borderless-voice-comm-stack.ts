import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as kinesisvideo from 'aws-cdk-lib/aws-kinesisvideo';
import { NodejsFunction, BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class BorderlessVoiceCommStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table for session management and conversation history
    // Stores transcription/translation results for debugging and analytics
    const sessionsTable = new dynamodb.Table(this, 'VoiceCommSessions', {
      tableName: `borderless-voice-comm-sessions`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl', // Auto-cleanup after 7 days
    });

    // Create AppSync Events API
    const eventsApi = new appsync.CfnApi(this, 'VoiceCommEventsAPI', {
      name: 'borderless-voice-comm-events-api',
      eventConfig: {
        authProviders: [
          {
            authType: 'API_KEY',
          },
          {
            authType: 'AWS_IAM',
          },
        ],
        connectionAuthModes: [
          {
            authType: 'API_KEY',
          },
          {
            authType: 'AWS_IAM',
          },
        ],
        defaultPublishAuthModes: [
          {
            authType: 'AWS_IAM',
          },
        ],
        defaultSubscribeAuthModes: [
          {
            authType: 'API_KEY',
          },
          {
            authType: 'AWS_IAM',
          },
        ],
      },
    });

    // Create API Key for AppSync Events API
    const apiKey = new appsync.CfnApiKey(this, 'VoiceCommEventsAPIKey', {
      apiId: eventsApi.attrApiId,
      expires: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60), // 1 year from now
    });

    // AppSync Events API channels are just string names - no need to pre-create them
    const audioChannelName = 'audio-events';
    const transcriptionChannelName = 'transcription-events';
    const translationChannelName = 'translation-events';
    const ttsChannelName = 'tts-events';

    // Kinesis Video Streams Signaling Channel for WebRTC
    // This replaces custom signaling - AWS manages everything!
    const kvsSignalingChannel = new kinesisvideo.CfnSignalingChannel(this, 'VoiceCommSignalingChannel', {
      name: 'borderless-voice-comm-signaling',
      type: 'SINGLE_MASTER', // One master (initiator), multiple viewers (receivers)
      messageTtlSeconds: 60,
    });

    // IAM Role for Lambda functions
    const lambdaRole = new iam.Role(this, 'VoiceCommLambdaRole', {
      roleName: `borderless-voice-comm-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Add permissions for DynamoDB
    sessionsTable.grantReadWriteData(lambdaRole);

    // Add permissions for AppSync Events API publishing
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'appsync:EventPublish',
        'appsync:EventConnect',
      ],
      resources: [
        `arn:aws:appsync:${this.region}:${this.account}:apis/${eventsApi.attrApiId}/*`,
      ],
    }));

    // Add permissions for Kinesis Video Streams (for WebRTC)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kinesisvideo:DescribeSignalingChannel',
        'kinesisvideo:GetSignalingChannelEndpoint',
        'kinesisvideo:GetIceServerConfig',
      ],
      resources: [kvsSignalingChannel.attrArn],
    }));

    // Add permissions for AWS services
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'polly:SynthesizeSpeech',
      ],
      resources: ['*'],
    }));

    // Add permissions for CloudWatch Logs
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));


    // Define bundling options for esbuild
    const bundlingOptions: BundlingOptions = {
      minify: true, // Minify code for production
      sourceMap: true, // Include sourcemaps for easier debugging
      target: 'node20', // Target Node.js version
      forceDockerBundling: false,
      nodeModules: [], // Bundle all node modules
      esbuildArgs: {
        '--tree-shaking': 'true',
        '--minify-whitespace': 'true',
        '--minify-identifiers': 'true',
        '--minify-syntax': 'true'
      }
    };

    const audioProcessorLogGroup = new logs.LogGroup(this, 'VoiceCommAudioProcessorLogGroup', {
      logGroupName: `/aws/lambda/borderless-voice-comm-audio-processor`,
      retention: logs.RetentionDays.FIVE_DAYS,
      removalPolicy: cdk.RemovalPolicy["DESTROY"]
    });
  
    const audioProcessor = new NodejsFunction(this, 'AudioProcessor', {
      functionName: `borderless-voice-comm-audio-processor`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: './lambda/audio-processor/index.js',
      handler: 'index.handler',
      bundling: bundlingOptions,
      role: lambdaRole,
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      logGroup: audioProcessorLogGroup, // Explicitly associate the log group
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0',
        APPSYNC_API_ID: eventsApi.attrApiId,
        APPSYNC_API_ENDPOINT: eventsApi.attrApiArn,
        TRANSCRIPTION_CHANNEL: transcriptionChannelName,
        TRANSLATION_CHANNEL: translationChannelName,
      }
    });

    const ttsHandlerLogGroup = new logs.LogGroup(this, 'VoiceCommTTSHandlerLogGroup', {
      logGroupName: `/aws/lambda/borderless-voice-comm-tts-handler`,
      retention: logs.RetentionDays.FIVE_DAYS,
      removalPolicy: cdk.RemovalPolicy["DESTROY"]
    });

    const ttsHandler = new NodejsFunction(this, 'TTSHandler', {
      functionName: `borderless-voice-comm-tts-handler`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: './lambda/tts-handler/index.js',
      handler: 'index.handler',
      bundling: bundlingOptions,
      role: lambdaRole,
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: ttsHandlerLogGroup, // Explicitly associate the log group
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
        POLLY_VOICE_ID: 'Joanna',
        APPSYNC_API_ID: eventsApi.attrApiId,
        APPSYNC_API_ENDPOINT: eventsApi.attrApiArn,
        TTS_CHANNEL: ttsChannelName,
      }
    });

    // Create Lambda Function URL for audio processing (allows client to invoke directly)
    const audioProcessorUrl = audioProcessor.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Use AWS_IAM in production
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['*'],
      },
    });

    // Create Lambda Function URL for TTS processing
    const ttsHandlerUrl = ttsHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Use AWS_IAM in production
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['*'],
      },
    });

    // Output important values
    new cdk.CfnOutput(this, 'AppSyncEventsApiId', {
      value: eventsApi.attrApiId,
      description: 'AppSync Events API ID',
      exportName: 'AppSyncEventsApiId',
    });

    new cdk.CfnOutput(this, 'AppSyncEventsApiArn', {
      value: eventsApi.attrApiArn,
      description: 'AppSync Events API ARN',
      exportName: 'AppSyncEventsApiArn',
    });

    new cdk.CfnOutput(this, 'AppSyncApiKey', {
      value: apiKey.attrApiKey,
      description: 'AppSync Events API Key',
      exportName: 'AppSyncApiKey',
    });

    new cdk.CfnOutput(this, 'AppSyncEventsHttpEndpoint', {
      value: `https://events.appsync-api.${this.region}.amazonaws.com/event`,
      description: 'AppSync Events HTTP Endpoint',
      exportName: 'AppSyncEventsHttpEndpoint',
    });

    new cdk.CfnOutput(this, 'AppSyncEventsRealtimeEndpoint', {
      value: `wss://events.appsync-realtime-api.${this.region}.amazonaws.com/event/realtime`,
      description: 'AppSync Events Realtime WebSocket Endpoint',
      exportName: 'AppSyncEventsRealtimeEndpoint',
    });

    new cdk.CfnOutput(this, 'AudioProcessorUrl', {
      value: audioProcessorUrl.url,
      description: 'Audio Processor Lambda Function URL',
      exportName: 'AudioProcessorUrl',
    });

    new cdk.CfnOutput(this, 'TTSHandlerUrl', {
      value: ttsHandlerUrl.url,
      description: 'TTS Handler Lambda Function URL',
      exportName: 'TTSHandlerUrl',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: sessionsTable.tableName,
      description: 'DynamoDB Sessions Table Name (for conversation history & analytics)',
      exportName: 'SessionsTableName',
    });

    new cdk.CfnOutput(this, 'AudioChannelName', {
      value: audioChannelName,
      description: 'Audio Events Channel Name',
      exportName: 'AudioChannelName',
    });

    new cdk.CfnOutput(this, 'TranscriptionChannelName', {
      value: transcriptionChannelName,
      description: 'Transcription Events Channel Name',
      exportName: 'TranscriptionChannelName',
    });

    new cdk.CfnOutput(this, 'TranslationChannelName', {
      value: translationChannelName,
      description: 'Translation Events Channel Name',
      exportName: 'TranslationChannelName',
    });

    new cdk.CfnOutput(this, 'TTSChannelName', {
      value: ttsChannelName,
      description: 'TTS Events Channel Name',
      exportName: 'TTSChannelName',
    });

    new cdk.CfnOutput(this, 'KVSSignalingChannelARN', {
      value: kvsSignalingChannel.attrArn,
      description: 'Kinesis Video Streams Signaling Channel ARN',
      exportName: 'KVSSignalingChannelARN',
    });

    new cdk.CfnOutput(this, 'KVSSignalingChannelName', {
      value: kvsSignalingChannel.name!,
      description: 'Kinesis Video Streams Signaling Channel Name',
      exportName: 'KVSSignalingChannelName',
    });
  }
}

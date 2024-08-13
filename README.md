# borderless-voice-comm
Cross-language communicator with OpenAI Whisper and Bedrock

High level architecture:

![alt text](https://github.com/mahdiridho/borderless-voice-comm/blob/master/images/Voice-CommV2.jpg?raw=true&ver=2)

Full design:

![alt text](https://github.com/mahdiridho/borderless-voice-comm/blob/master/images/Full-Arch-Voice-CommV2.jpg?raw=true&ver=2)


# Prerequisites
1. Cognito Identity Pool with Guest (Unauthenticated) IAM Role
2. Set the IAM Role policies for both guest and lambda (see the files client-policies.json & backend-policies.json)
3. Lambda function, code is provided in the folder CommAILambda
4. SQS Queue (standard type)
5. S3 bucket for batch trascribe processing
6. S3 static bucket and Cloudfront (optional if you want to publish and make it live)

# Upload Lambda Function
1. install the libraries ```npm i```
2. Update the function.js file
3. Update the config.json
4. Build the function ```npm run build```
5. Deploy the code by running ```./update-function-code.sh```

# Run the Apps
1. install the libraries ```npm i```
2. run it ```npm run start```
3. to run build version ```npm run start:build```

# Publish static apps
Just run the command ```./awsSetup.sh```

# Demo
[Blurb Communicator](https://dwb75hpa77xa8.cloudfront.net/)

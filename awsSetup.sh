#!/bin/bash

npm run build
pushd dist
aws --profile <CRED_PROFILE> s3 sync . s3://<S3_STATIC_BUCKET> --delete --sse AES256 --cache-control no-cache
popd
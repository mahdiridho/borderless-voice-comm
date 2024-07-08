#!/usr/bin/env bash

profile=""
region=""
projectName=""

# Getting project configurations
get_project_config() {
  input="./function/config.json"
  if [ ! -f $input ]; then
    echo "Config file not found!"
    echo "Please run ./initial-setup.sh script to generate the config file"
    exit
  fi
  while IFS= read -r line
  do
    text=`echo "$line"`
    if [[ "$text" == *'"profile":'* ]]; then
      profile=$(echo "$text" | sed 's|.*: "||; s/\b*$//')
      profile=$(echo "$profile" | sed 's|",.*||; s/\b*$//')
    fi
    if [[ "$text" == *'"region":'* ]]; then
      region=$(echo "$text" | sed 's|.*: "||; s/\b*$//')
      region=$(echo "$region" | sed 's|",.*||; s/\b*$//')
    fi
    if [[ "$text" == *'"projectName":'* ]]; then
      projectName=$(echo "$text" | sed 's|.*: "||; s/\b*$//')
      projectName=$(echo "$projectName" | sed 's|".*||; s/\b*$//')
    fi
  done < "$input"
}

# question check the answer
Question() {
  whichVal=''
  while [ -z "$whichVal" ]; do
    for p in $3; do
      if [[ "$p" != *${projectName}* ]] ; then
        continue
      fi
      p=$(echo "$p" | sed "s/\"//g")
      p=$(echo "$p" | sed "s/,//g")
      echo $p
    done

  	echo
  	echo $2
  	read result

    whichVal=`echo $3 | grep "$result"`
  done
	local answer=$1
	if [ "$result" != '' ]; then
		eval $answer="'$result'"
  else
    Question "$1" "$2" "$3"
    return
	fi
}

create_zip() {
  echo
  echo creating the zip function file
  # always delete the old zip function file to make sure it's clean
  if [ -f "/tmp/${projectName}.zip" ]; then
      rm /tmp/${projectName}.zip
  fi
  pushd function
    rm -rf package-lock.json node_modules build
    npm i
    rm -rf package-lock.json
    npm run build
    cp config.json build
    cd build
    zip -y9r /tmp/${projectName}.zip *
  popd
}

create_bucket() {
  echo
  echo checking the s3 bucket $projectName on the $profile account and region $region
  checkTest=$(aws --region=$region --profile=$profile \
    s3api head-bucket \
    --bucket $projectName 2>&1)
  if [ $? -eq 0 ]; then
    # make sure we use fresh bucket
    echo Get rid of the old bucket
    delete_bucket
  fi
  echo creating the s3 bucket $projectName on the $profile account and region $region
  if [ ${region} == "us-east-1" ]; then
    createBucket=$(aws --region=$region --profile=$profile \
      s3api create-bucket \
      --bucket $projectName)
  else
    createBucket=$(aws --region=$region --profile=$profile \
      s3api create-bucket \
      --bucket $projectName \
      --create-bucket-configuration \
      LocationConstraint=$region)
  fi

  # "Location": "<bucket_name>" for the US region
  # "Location": "http://<bucket_name>.s3.amazonaws.com" for the non-US region
  echo $createBucket
  if [[ $createBucket != *'"Location": "'* ]]; then
    echo
    echo Failed to create the bucket
    exit 1
  fi
}

upload_zip() {
  echo
  echo uploading the zip file to bucket
  uploadZip=$(aws --region=$region --profile=$profile \
    s3 cp /tmp/${projectName}.zip s3://$projectName)

  echo $uploadZip
  if [[ $uploadZip != *"upload:"* ]]; then
    echo
    echo Failed to upload the zip file
    echo
    delete_bucket
    exit 1
  elif [[ $uploadZip != *" to s3://$projectName/${projectName}.zip"* ]]; then
    echo
    echo Failed to upload the zip file
    echo the file name should be ${projectName}.zip
    echo
    delete_bucket
    exit 1
  fi
}

update_code() {
  echo
  updateCode=$(aws --region=$region --profile=$profile \
    lambda update-function-code \
    --function-name $funcName \
    --s3-bucket $projectName \
    --s3-key ${projectName}.zip)
  echo $updateCode

  if [[ $updateCode == *'"LastUpdateStatus": "InProgress"'* ]]; then
    wait_for
  elif [[ $updateCode != *'"LastUpdateStatus": "Successful"'* ]]; then
    echo
    echo Failed to update the code
    echo
    delete_bucket
    exit 1
  fi
}

wait_for() {
  echo
  echo Updating in progress, please wait
  waitUpdated=$(aws --region=$region --profile=$profile \
    lambda wait function-updated \
    --function-name $funcName)
  if [ -z "$waitUpdated" ]; then
    echo Succeed to update the code
  else
    echo
    echo Failed to update the code
    echo $waitUpdated
    echo
    delete_bucket
    exit 1
  fi
}

delete_bucket() {
  echo
  echo deleting the s3 bucket
  emptyBuck=$(aws --region=$region --profile=$profile \
    s3 rm s3://$projectName --recursive)
  deleteBuck=$(aws --region=$region --profile=$profile \
    s3api delete-bucket --bucket $projectName)
}

echo ======
echo Creating sts cross role
echo

echo
# does aws cli exist?
if ! command -v aws &> /dev/null;then
  echo "aws cli could not be found"
  echo "please follow the readme to install the aws cli onto your system"
  exit
else
  echo "aws cli is available"
fi

# does aws credential profile file exist?
if [ ! -f ~/.aws/credentials ]; then
  echo "AWS profile file doesn't exist!"
  exit
else
  echo "AWS profile file exists"
fi

get_project_config
echo
echo The function list:
functions=`aws --profile $profile --region $region lambda list-functions | grep FunctionName &`
Question funcName "Which function name should be updated?" "$functions"

create_zip
create_bucket
upload_zip
update_code
delete_bucket

echo
echo done
pwd
echo ======
echo

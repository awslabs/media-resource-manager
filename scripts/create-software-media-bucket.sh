#!/bin/bash
set -e

# Configuration
REGION="us-east-1"
BUCKET_NAME="mrm-software-media-$(aws sts get-caller-identity --query Account --output text)-${REGION}"
DISTRIBUTION_COMMENT="Software Installation Media Distribution"

echo "Creating S3 bucket: ${BUCKET_NAME}"

# Create S3 bucket (us-east-1 doesn't need LocationConstraint)
aws s3api create-bucket \
    --bucket "${BUCKET_NAME}" \
    --region "${REGION}"

# Block all public access
aws s3api put-public-access-block \
    --bucket "${BUCKET_NAME}" \
    --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Enable versioning
aws s3api put-bucket-versioning \
    --bucket "${BUCKET_NAME}" \
    --versioning-configuration Status=Enabled

# Enable server-side encryption
aws s3api put-bucket-encryption \
    --bucket "${BUCKET_NAME}" \
    --server-side-encryption-configuration '{
        "Rules": [
            {
                "ApplyServerSideEncryptionByDefault": {
                    "SSEAlgorithm": "AES256"
                },
                "BucketKeyEnabled": true
            }
        ]
    }'

echo "Creating CloudFront Origin Access Control..."

# Create Origin Access Control
OAC_ID=$(aws cloudfront create-origin-access-control \
    --origin-access-control-config "{
        \"Name\": \"${BUCKET_NAME}-oac\",
        \"Description\": \"OAC for software media bucket\",
        \"SigningProtocol\": \"sigv4\",
        \"SigningBehavior\": \"always\",
        \"OriginAccessControlOriginType\": \"s3\"
    }" \
    --query 'OriginAccessControl.Id' \
    --output text)

echo "OAC created: ${OAC_ID}"

echo "Creating CloudFront distribution..."

# Create CloudFront distribution
DISTRIBUTION_CONFIG=$(cat <<EOF
{
    "CallerReference": "$(date +%s)",
    "Comment": "${DISTRIBUTION_COMMENT}",
    "Enabled": true,
    "Origins": {
        "Quantity": 1,
        "Items": [
            {
                "Id": "S3-${BUCKET_NAME}",
                "DomainName": "${BUCKET_NAME}.s3.${REGION}.amazonaws.com",
                "OriginAccessControlId": "${OAC_ID}",
                "S3OriginConfig": {
                    "OriginAccessIdentity": ""
                }
            }
        ]
    },
    "DefaultCacheBehavior": {
        "TargetOriginId": "S3-${BUCKET_NAME}",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 2,
            "Items": ["GET", "HEAD"],
            "CachedMethods": {
                "Quantity": 2,
                "Items": ["GET", "HEAD"]
            }
        },
        "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
        "Compress": true
    },
    "PriceClass": "PriceClass_100",
    "ViewerCertificate": {
        "CloudFrontDefaultCertificate": true,
        "MinimumProtocolVersion": "TLSv1.2_2021"
    },
    "HttpVersion": "http2and3"
}
EOF
)

DISTRIBUTION_ID=$(aws cloudfront create-distribution \
    --distribution-config "${DISTRIBUTION_CONFIG}" \
    --query 'Distribution.Id' \
    --output text)

DISTRIBUTION_DOMAIN=$(aws cloudfront get-distribution \
    --id "${DISTRIBUTION_ID}" \
    --query 'Distribution.DomainName' \
    --output text)

echo "CloudFront distribution created: ${DISTRIBUTION_ID}"

echo "Updating S3 bucket policy to allow CloudFront access..."

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create bucket policy allowing CloudFront OAC access
BUCKET_POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowCloudFrontServicePrincipal",
            "Effect": "Allow",
            "Principal": {
                "Service": "cloudfront.amazonaws.com"
            },
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::${BUCKET_NAME}/*",
            "Condition": {
                "StringEquals": {
                    "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DISTRIBUTION_ID}"
                }
            }
        }
    ]
}
EOF
)

aws s3api put-bucket-policy \
    --bucket "${BUCKET_NAME}" \
    --policy "${BUCKET_POLICY}"

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo "S3 Bucket: ${BUCKET_NAME}"
echo "CloudFront Distribution ID: ${DISTRIBUTION_ID}"
echo "CloudFront Domain: https://${DISTRIBUTION_DOMAIN}"
echo ""
echo "To upload software media:"
echo "  aws s3 cp <file> s3://${BUCKET_NAME}/"
echo ""
echo "Users can download via:"
echo "  https://${DISTRIBUTION_DOMAIN}/<filename>"
echo "=========================================="

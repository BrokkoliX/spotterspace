// SpotterSpace AWS Infrastructure — CDK v2
// Architecture: CloudFront → ECS Fargate (web + API) → ALB → RDS via VPC
import { CfnOutput, Duration as cdkDuration, Stack, StackProps } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_route53 as route53,
  aws_secretsmanager as secretsmanager,
  aws_s3 as s3,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface SpotterSpaceStackProps extends StackProps {
  stage: 'dev' | 'prod';
  domainName?: string;
  hostedZoneId?: string;
  vpcId: string;
  albArn?: string;
  ecsSecurityGroupId?: string;
  ecsSubnetIds?: string[];
  /**
   * When true, provisions a CloudFront distribution (with apex-to-www
   * redirect, CDN certificate, and apex A-record alias) in front of the ALB.
   * Defaults to false so existing HTTPS-on-ALB deployments are unaffected.
   */
  enableCloudFront?: boolean;
  /**
   * When true, provisions VPC interface endpoints for ECR (api + dkr) and
   * CloudWatch Logs so ECS task egress for those services bypasses the NAT
   * Gateway. Defaults to false because the savings depend on NAT data
   * volume and these endpoints can conflict with pre-existing private DNS
   * reservations in the VPC.
   */
  enableVpcEndpoints?: boolean;
  /**
   * ECR image tag for the api container. Typically a git sha supplied by CI
   * (e.g. API_IMAGE_TAG=$GITHUB_SHA). Falls back to 'latest' when unset, but
   * pinning to an immutable tag is strongly recommended so every task in a
   * service pulls identical code and rollbacks are deterministic.
   */
  apiImageTag?: string;
  /**
   * ECR image tag for the web container. Same semantics as apiImageTag.
   */
  webImageTag?: string;
}

export class SpotterSpaceStack extends Stack {
  constructor(scope: Construct, id: string, props: SpotterSpaceStackProps) {
    super(scope, id, props);

    const {
      stage,
      domainName,
      hostedZoneId,
      vpcId,
      albArn,
      ecsSecurityGroupId,
      ecsSubnetIds,
      enableCloudFront = false,
      enableVpcEndpoints = false,
      apiImageTag = 'latest',
      webImageTag = 'latest',
    } = props;

    // ─── VPC ───────────────────────────────────────────────────────────────
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', { vpcId });

    // Use only private subnets for ECS tasks (so they can reach Secrets Manager via interface endpoint)
    const subnetIds = ecsSubnetIds ?? ['subnet-082c94f0897298f6e', 'subnet-096b774ed307c85ed'];

    const ecsSgId = ecsSecurityGroupId ?? 'sg-08e5864c53710a095';
    const ecsSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'EcsSecurityGroup', ecsSgId);

    // ─── Additional SG Rules (previously manual) ───────────────────────────
    // Secrets Manager endpoint SG — allow ECS to pull secrets
    const secretsEndpointSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'SecretsEndpointSG',
      'sg-0ddf2cd67fa1b09f0',
    );
    secretsEndpointSg.addIngressRule(
      ecsSg,
      ec2.Port.tcp(443),
      'Allow ECS to reach Secrets Manager',
    );

    // RDS SG — allow ECS to connect to database
    const rdsSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'RdsSG', 'sg-0925439b428efdf13');
    rdsSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), 'Allow ECS to reach RDS');

    // ECS/ALB SG — self-referencing so ALB can forward to ECS tasks
    ecsSg.addIngressRule(ecsSg, ec2.Port.allTraffic(), 'Allow ALB to ECS traffic');

    // ─── VPC Endpoints (opt-in) ────────────────────────────────────────────
    // Eliminate NAT Gateway data-processing charges for ECR image pulls and
    // CloudWatch Logs ingestion. Each interface endpoint costs ~$7/mo, so
    // the net win depends on actual NAT data volume. Disabled by default
    // because privateDnsEnabled can clash with pre-existing reservations
    // in the VPC if endpoints were ever created and torn down recently.
    if (enableVpcEndpoints) {
      const endpointSubnetSelection: ec2.SubnetSelection = {
        subnets: subnetIds.map((id, i) => ec2.Subnet.fromSubnetId(this, `EndpointSubnet${i}`, id)),
      };

      new ec2.InterfaceVpcEndpoint(this, 'EcrApiEndpoint', {
        vpc,
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
        subnets: endpointSubnetSelection,
        securityGroups: [ecsSg],
        privateDnsEnabled: true,
      });

      new ec2.InterfaceVpcEndpoint(this, 'EcrDockerEndpoint', {
        vpc,
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        subnets: endpointSubnetSelection,
        securityGroups: [ecsSg],
        privateDnsEnabled: true,
      });

      new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
        vpc,
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        subnets: endpointSubnetSelection,
        securityGroups: [ecsSg],
        privateDnsEnabled: true,
      });
    }

    // S3 gateway endpoint already exists out-of-band on rtb-0989410e3b8f596fc
    // as vpce-0949a6870cff22264 (created before this CDK stack). It still
    // serves its purpose (free ECR layer pulls + S3 bucket access without
    // NAT data charges); we just don't manage it here. To bring it under CDK
    // management later, import via `cdk import` rather than redeclaring it.

    // ─── Task sizing (stage-aware) ─────────────────────────────────────────
    // Dev workload is single-instance and sees minimal traffic, so both
    // services run at the smallest Fargate size (256 CPU / 512 MB).
    // Empirical baseline (2026-05-25, task def :254): the api boots cleanly
    // on 256/512 with a brief CPU peak around 42% during Prisma migrate +
    // Apollo startup, then settles to <1% CPU and ~13% memory steady-state.
    // An older comment here claimed 256/512 OOM-killed at boot; that was
    // observed under different conditions (heavier image and zombie task
    // contention) and no longer holds. Prod retains generous headroom for
    // real traffic; revisit if dev memory peaks ever exceed ~70%.
    const apiTaskCpu = stage === 'prod' ? '1024' : '256';
    const apiTaskMemory = stage === 'prod' ? '2048' : '512';
    const webTaskCpu = stage === 'prod' ? '1024' : '256';
    const webTaskMemory = stage === 'prod' ? '2048' : '512';

    // ─── ALB ──────────────────────────────────────────────────────────────
    const albArnStr =
      albArn ??
      'arn:aws:elasticloadbalancing:us-east-1:654654553862:loadbalancer/app/spotterspace-alb/c1d7545a9ffd1121';
    const alb = elbv2.ApplicationLoadBalancer.fromLookup(this, 'ExistingALB', {
      loadBalancerArn: albArnStr,
    });

    // ─── S3 Bucket ─────────────────────────────────────────────────────────
    const photosBucket = s3.Bucket.fromBucketName(
      this,
      'PhotosBucket',
      process.env['S3_BUCKET_NAME'] ?? 'spotterhub-photos',
    );

    // ─── Secrets ───────────────────────────────────────────────────────────
    const dbUrlSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'DBUrlSecret',
      'arn:aws:secretsmanager:us-east-1:654654553862:secret:spotterhub/DATABASE_URL-fFpNor',
    );

    const jwtSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'JWTSecret',
      'arn:aws:secretsmanager:us-east-1:654654553862:secret:spotterhub/JWT_SECRET-V8C46k',
    );

    const resendSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ResendSecret',
      'arn:aws:secretsmanager:us-east-1:654654553862:secret:spotterhub/RESEND_API_KEY-H26Fqt',
    );

    // ─── ECR Repos ─────────────────────────────────────────────────────────
    const webEcrRepo = ecr.Repository.fromRepositoryName(
      this,
      'WebEcrRepo',
      `spotterspace-${stage}-web`,
    );
    const apiEcrRepo = ecr.Repository.fromRepositoryName(
      this,
      'ApiEcrRepo',
      `spotterspace-${stage}-api`,
    );

    // ─── IAM Roles ─────────────────────────────────────────────────────────
    const taskExecutionRole = iam.Role.fromRoleArn(
      this,
      'TaskExecutionRole',
      'arn:aws:iam::654654553862:role/ecsTaskExecutionRole',
    );

    const taskRole = iam.Role.fromRoleArn(
      this,
      'TaskRole',
      'arn:aws:iam::654654553862:role/ecsSpotterSpaceTaskRole',
    );

    // ─── Log Groups ────────────────────────────────────────────────────────
    const apiLogGroup = new LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/ecs/spotterspace-${stage}/api`,
      retention: RetentionDays.ONE_WEEK,
    });

    const webLogGroup = new LogGroup(this, 'WebLogGroup', {
      logGroupName: `/ecs/spotterspace-${stage}/web`,
      retention: RetentionDays.ONE_WEEK,
    });

    // ─── Target Groups (Cfn for dependency ordering) ─────────────────────
    const apiTG = new elbv2.CfnTargetGroup(this, 'ApiTargetGroup', {
      name: `spotterspace-${stage}-api-tg`,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpcId,
      targetType: 'ip',
      healthCheckPath: '/health',
      healthCheckIntervalSeconds: 30,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    const webTG = new elbv2.CfnTargetGroup(this, 'WebTargetGroup', {
      name: `spotterspace-${stage}-web-tg`,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpcId,
      targetType: 'ip',
      healthCheckPath: '/api/health',
      healthCheckIntervalSeconds: 30,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // ─── ALB Listener (HTTP :80) ───────────────────────────────────────────
    // Created BEFORE ECS services so target groups are registered.
    //
    // Every :80 request is 301-redirected to the same host/path/query over
    // HTTPS. CloudFront is not deployed (enableCloudFront defaults to false),
    // so browsers hit this ALB directly and plain HTTP used to be served
    // unencrypted. Nothing depends on :80 — ALB health checks go straight to
    // the targets, and the keep-warm Lambda already calls https:// URLs.
    //
    // Applied to the live ALB on 2026-09-19 via AWS CLI (cdk deploy was
    // blocked by pre-existing drift — see DEPLOYMENT_STATUS.md); this code
    // matches that state.
    const httpsRedirect = {
      type: 'redirect',
      redirectConfig: {
        protocol: 'HTTPS',
        port: '443',
        host: '#{host}',
        path: '/#{path}',
        query: '#{query}',
        statusCode: 'HTTP_301',
      },
    };

    const httpListener = new elbv2.CfnListener(this, 'HttpListener', {
      loadBalancerArn: alb.loadBalancerArn,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 80,
      defaultActions: [httpsRedirect],
    });

    // Host-based rules on the HTTP listener. They take precedence over the
    // default action, so they must redirect too — otherwise api.* and www.*
    // would still be served over plain HTTP. Kept (rather than deleted) so
    // the CloudFormation-owned resources stay in step with the live ALB.
    const apiListenerRule = new elbv2.CfnListenerRule(this, 'ApiListenerRule', {
      listenerArn: httpListener.ref,
      priority: 100,
      conditions: [
        {
          field: 'host-header',
          hostHeaderConfig: {
            values: [`api.${domainName ?? 'spotterspace.com'}`],
          },
        },
      ],
      actions: [httpsRedirect],
    });

    const webListenerRule = new elbv2.CfnListenerRule(this, 'WebListenerRule', {
      listenerArn: httpListener.ref,
      priority: 200,
      conditions: [
        {
          field: 'host-header',
          hostHeaderConfig: {
            values: [`www.${domainName ?? 'spotterspace.com'}`],
          },
        },
      ],
      actions: [httpsRedirect],
    });

    // ─── HTTPS Listener (443) ──────────────────────────────────────────────
    // CDK will create the cert and add DNS validation records to Route53
    let httpsListener: elbv2.CfnListener | null = null;

    if (domainName && hostedZoneId) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HttpsHostedZone', {
        hostedZoneId,
        zoneName: domainName,
      });

      const certificate = new acm.Certificate(this, 'SiteCertificate', {
        domainName,
        subjectAlternativeNames: [`*.${domainName}`],
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      httpsListener = new elbv2.CfnListener(this, 'HttpsListener', {
        loadBalancerArn: alb.loadBalancerArn,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        port: 443,
        certificates: [{ certificateArn: certificate.certificateArn }],
        defaultActions: [
          {
            type: 'forward',
            targetGroupArn: webTG.ref,
          },
        ],
      });

      // Host-based HTTPS rule: api.spotterspace.com → apiTG (priority 100)
      new elbv2.CfnListenerRule(this, 'HttpsApiListenerRule', {
        listenerArn: httpsListener.ref,
        priority: 100,
        conditions: [
          {
            field: 'host-header',
            hostHeaderConfig: {
              values: [`api.${domainName}`],
            },
          },
        ],
        actions: [
          {
            type: 'forward',
            targetGroupArn: apiTG.ref,
          },
        ],
      });

      // ─── CloudFront Distribution (opt-in) ────────────────────────────────
      // Handles HTTPS for www + apex, and apex→www redirect.
      // Only provisioned when enableCloudFront is true so existing
      // HTTPS-on-ALB deployments aren't churned.
      if (enableCloudFront) {
        // CloudFront function: redirect apex domain (non-www) to www
        const apexRedirectFunction = new cloudfront.CfnFunction(this, 'ApexRedirectFunction', {
          name: 'ApexRedirect',
          functionCode: `
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  if (host === '${domainName}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        'location': { value: 'https://www.${domainName}' + request.uri },
        'host': { value: 'www.${domainName}' }
      }
    };
  }
  return request;
}
        `,
          functionConfig: {
            runtime: 'cloudfront-js-1.0',
            comment: 'Redirect apex domain to www',
          },
        });

        // ─── CloudFront Response Headers Policy ─────────────────────────────
        //
        // Sprint 1 (S1.2) + Sprint 3 (S3.4): apply browser-side hardening
        // headers at the edge so every CloudFront response carries them
        // regardless of what the origin emits. Headers selected:
        //
        //   - Strict-Transport-Security: 1y + includeSubdomains + preload.
        //     Once preloaded, browsers will refuse to reach the site over
        //     plaintext even before the first visit.
        //   - X-Content-Type-Options: nosniff. Prevents MIME-sniffing-based
        //     XSS via untrusted uploads.
        //   - X-Frame-Options: DENY. Defense-in-depth against clickjacking
        //     for browsers that do not honour CSP frame-ancestors.
        //   - Referrer-Policy: strict-origin-when-cross-origin. Hides paths
        //     and query from cross-origin Referers.
        //   - Permissions-Policy: deny camera, mic, geolocation, payment
        //     unless explicitly opted-in by a feature using them.
        //   - Content-Security-Policy: a baseline that allows the site's own
        //     scripts, styles, and CloudFront-served images. Per-request
        //     nonces are NOT applied here — those require a Next.js
        //     middleware integration (tracked separately in S1.2 part 2).
        //     The baseline still rejects cross-origin script and inline
        //     event handlers, which is the bulk of XSS-vector reduction.
        const csp = [
          `default-src 'self'`,
          // 'unsafe-inline' for styles is unfortunately required by Next.js
          // App Router's runtime CSS handling without nonces. 'unsafe-eval'
          // is required by some dev toolchains; remove once we're confident
          // production builds don't ship it.
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://api.mapbox.com`,
          `style-src 'self' 'unsafe-inline' https://api.mapbox.com`,
          `img-src 'self' data: blob: https://*.cloudfront.net https://*.s3.amazonaws.com https://*.s3.${this.region}.amazonaws.com https://api.mapbox.com`,
          `font-src 'self' data:`,
          `connect-src 'self' https://api.mapbox.com https://events.mapbox.com`,
          `worker-src 'self' blob:`,
          `frame-ancestors 'none'`,
          `base-uri 'self'`,
          `form-action 'self'`,
        ].join('; ');

        const responseHeadersPolicy = new cloudfront.CfnResponseHeadersPolicy(
          this,
          'CdnResponseHeadersPolicy',
          {
            responseHeadersPolicyConfig: {
              name: `spotterspace-${stage}-security-headers`,
              comment: 'Browser-side security headers for SpotterHub (S1.2 / S3.4).',
              securityHeadersConfig: {
                strictTransportSecurity: {
                  accessControlMaxAgeSec: 31536000,
                  includeSubdomains: true,
                  preload: true,
                  override: true,
                },
                contentTypeOptions: {
                  override: true,
                },
                frameOptions: {
                  frameOption: 'DENY',
                  override: true,
                },
                referrerPolicy: {
                  referrerPolicy: 'strict-origin-when-cross-origin',
                  override: true,
                },
                contentSecurityPolicy: {
                  contentSecurityPolicy: csp,
                  override: false, // Allow Next.js middleware to override per-request when nonces land.
                },
              },
              customHeadersConfig: {
                items: [
                  {
                    header: 'Permissions-Policy',
                    value: 'camera=(), microphone=(), geolocation=(self), payment=()',
                    override: true,
                  },
                ],
              },
            },
          },
        );

        const distribution = new cloudfront.CfnDistribution(this, 'CdnDistribution', {
          distributionConfig: {
            enabled: true,
            priceClass: 'PriceClass_100',
            aliases: [domainName, `www.${domainName}`],
            viewerCertificate: {
              acmCertificateArn: new acm.Certificate(this, 'CdnCertificate', {
                domainName,
                subjectAlternativeNames: [`*.${domainName}`],
                validation: acm.CertificateValidation.fromDns(hostedZone),
              }).certificateArn,
              sslSupportMethod: 'sni-only',
            },
            defaultRootObject: '/',
            origins: [
              {
                id: 'web-origin',
                domainName: alb.loadBalancerDnsName,
                originCustomHeaders: [{ headerName: 'Host', headerValue: `www.${domainName}` }],
                connectionAttempts: 3,
                connectionTimeout: 10,
              },
              {
                id: 'api-origin',
                domainName: alb.loadBalancerDnsName,
                originCustomHeaders: [{ headerName: 'Host', headerValue: `api.${domainName}` }],
                connectionAttempts: 3,
                connectionTimeout: 10,
              },
            ],
            defaultCacheBehavior: {
              targetOriginId: 'web-origin',
              viewerProtocolPolicy: 'redirect-to-https',
              allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
              cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
              compress: true,
              minTtl: 0,
              defaultTtl: 0,
              maxTtl: 0,
              responseHeadersPolicyId: responseHeadersPolicy.ref,
              functionAssociations: [
                {
                  functionArn: apexRedirectFunction.getAtt('Arn').toString(),
                  eventType: 'viewer-request',
                },
              ],
            },
            cacheBehaviors: [
              {
                // Next.js fingerprinted static assets — safe to cache for a year.
                // These are immutable; filenames change when content changes.
                pathPattern: '/_next/static/*',
                targetOriginId: 'web-origin',
                viewerProtocolPolicy: 'redirect-to-https',
                allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
                minTtl: 0,
                defaultTtl: 31536000, // 1 year
                maxTtl: 31536000,
                compress: true,
                responseHeadersPolicyId: responseHeadersPolicy.ref,
              },
              {
                // Next.js Image Optimization output — cache for a day to avoid
                // re-running Sharp on every request, but allow daily refresh.
                pathPattern: '/_next/image*',
                targetOriginId: 'web-origin',
                viewerProtocolPolicy: 'redirect-to-https',
                allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
                minTtl: 0,
                defaultTtl: 86400, // 1 day
                maxTtl: 604800, // 1 week ceiling
                compress: true,
                responseHeadersPolicyId: responseHeadersPolicy.ref,
              },
              {
                pathPattern: '/graphql',
                targetOriginId: 'api-origin',
                viewerProtocolPolicy: 'https-only',
                allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
                cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
                minTtl: 0,
                defaultTtl: 0,
                maxTtl: 0,
                compress: true,
                responseHeadersPolicyId: responseHeadersPolicy.ref,
              },
            ],
          },
        });

        // ─── Route 53 Records (apex alias requires CloudFront distribution) ──
        // Apex domain → CloudFront alias (A record)
        new route53.CfnRecordSet(this, 'ApexARecord', {
          name: domainName,
          type: 'A',
          hostedZoneId,
          aliasTarget: {
            hostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront global hosted zone ID
            dnsName: distribution.getAtt('domainName').toString(),
          },
        });
      } // end if (enableCloudFront)

      // ─── Apex → www (when CloudFront is not handling it) ─────────────────
      // The apex had no DNS record at all, so https://spotterspace.com did not
      // resolve. Alias it to the ALB and 301 it to www on :443. (:80 needs no
      // rule: the default action upgrades it to https://spotterspace.com,
      // which then lands here.) The certificate already covers the apex.
      // Applied to the live stack on 2026-09-19 via AWS CLI — see the :80
      // listener note above.
      if (!enableCloudFront && httpsListener) {
        new elbv2.CfnListenerRule(this, 'HttpsApexRedirectRule', {
          listenerArn: httpsListener.ref,
          priority: 50,
          conditions: [{ field: 'host-header', hostHeaderConfig: { values: [domainName] } }],
          actions: [
            {
              type: 'redirect',
              redirectConfig: {
                protocol: 'HTTPS',
                port: '443',
                host: `www.${domainName}`,
                path: '/#{path}',
                query: '#{query}',
                statusCode: 'HTTP_301',
              },
            },
          ],
        });

        new route53.CfnRecordSet(this, 'ApexAlbAliasRecord', {
          name: domainName,
          type: 'A',
          hostedZoneId,
          aliasTarget: {
            hostedZoneId: alb.loadBalancerCanonicalHostedZoneId,
            dnsName: `dualstack.${alb.loadBalancerDnsName}`,
            evaluateTargetHealth: false,
          },
        });
      }

      // www → ALB (CNAME, always present regardless of CloudFront)
      new route53.CnameRecord(this, 'WwwCnameRecord', {
        zone: hostedZone,
        recordName: `www.${domainName}`,
        domainName: alb.loadBalancerDnsName,
      });

      // api → ALB directly
      new route53.CnameRecord(this, 'ApiCnameRecord', {
        zone: hostedZone,
        recordName: `api.${domainName}`,
        domainName: alb.loadBalancerDnsName,
      });
    }

    // ─── Task Definitions (Cfn) ─────────────────────────────────────────────
    const apiTaskDef = new ecs.CfnTaskDefinition(this, 'ApiTaskDef', {
      family: `spotterspace-${stage}-api`,
      cpu: apiTaskCpu,
      memory: apiTaskMemory,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      executionRoleArn: taskExecutionRole.roleArn,
      taskRoleArn: taskRole.roleArn,
      containerDefinitions: [
        {
          name: 'api',
          image: apiEcrRepo.repositoryUri + ':' + apiImageTag,
          portMappings: [{ containerPort: 4000, protocol: 'tcp' }],
          secrets: [
            { name: 'DATABASE_URL', valueFrom: dbUrlSecret.secretArn + ':DATABASE_URL::' },
            { name: 'JWT_SECRET', valueFrom: jwtSecret.secretArn + ':JWT_SECRET::' },
          ],
          environment: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'STAGE', value: stage },
            { name: 'AWS_REGION', value: this.region },
            { name: 'API_PORT', value: '4000' },
            { name: 'S3_BUCKET', value: photosBucket.bucketName },
            {
              name: 'WEB_BASE_URL',
              value: domainName ? `https://www.${domainName}` : 'https://www.spotterspace.com',
            },
            {
              name: 'FROM_EMAIL',
              value: 'SpotterSpace <noreply@noreply.spotterspace.com>',
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': apiLogGroup.logGroupName,
              'awslogs-stream-prefix': 'api',
              'awslogs-region': this.region,
            },
          },
          healthCheck: {
            command: ['CMD', 'wget', '-qO-', 'http://localhost:4000/health'],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 30,
          },
        },
      ],
    });

    const webTaskDef = new ecs.CfnTaskDefinition(this, 'WebTaskDef', {
      family: `spotterspace-${stage}-web`,
      cpu: webTaskCpu,
      memory: webTaskMemory,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      executionRoleArn: taskExecutionRole.roleArn,
      containerDefinitions: [
        {
          name: 'web',
          image: webEcrRepo.repositoryUri + ':' + webImageTag,
          portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
          environment: [
            { name: 'NODE_ENV', value: 'production' },
            {
              name: 'NEXT_PUBLIC_API_URL',
              value: domainName
                ? `https://api.${domainName}/graphql`
                : 'https://api.spotterspace.com/graphql',
            },
            {
              name: 'NEXT_PUBLIC_GA_MEASUREMENT_ID',
              value: 'G-DC910C9R5M',
            },
            // TODO(infra): Add WEB_BASE_URL back here once the deploy.yml /
            // CDK split-brain is resolved. The variable was previously
            // defined on this task def, but live state does not have it
            // because GitHub Actions registers task definitions by copying
            // env vars from the previous revision (so CDK-only additions
            // never propagate). Removed on 2026-05-24 to clear cdk diff;
            // restore once the deploy pipeline reads from CDK output or
            // CDK becomes the sole deploy path.
            { name: 'HOSTNAME', value: '0.0.0.0' },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': webLogGroup.logGroupName,
              'awslogs-stream-prefix': 'web',
              'awslogs-region': this.region,
            },
          },
          healthCheck: {
            command: ['CMD', 'wget', '-qO-', 'http://localhost:3000/api/health'],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 30,
          },
        },
      ],
    });

    // ─── ECS Cluster ────────────────────────────────────────────────────────
    const cluster = ecs.Cluster.fromClusterArn(
      this,
      'EcsCluster',
      `arn:aws:ecs:${this.region}:654654553862:cluster/spotterspace-cluster`,
    );

    // ─── ECS Services — use CfnService (L2 FargateService has taskRole runtime requirement) ─
    // loadBalancers config auto-registers task IPs with ALB target groups
    const apiService = new ecs.CfnService(this, 'ApiService', {
      cluster: cluster.clusterName,
      serviceName: `spotterspace-${stage}-api`,
      taskDefinition: apiTaskDef.ref,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnetIds,
          securityGroups: [ecsSgId],
          assignPublicIp: 'DISABLED',
        },
      },
      loadBalancers: [
        {
          containerName: 'api',
          containerPort: 4000,
          targetGroupArn: apiTG.ref,
        },
      ],
    });

    const webService = new ecs.CfnService(this, 'WebService', {
      cluster: cluster.clusterName,
      serviceName: `spotterspace-${stage}-web`,
      taskDefinition: webTaskDef.ref,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnetIds,
          securityGroups: [ecsSgId],
          assignPublicIp: 'DISABLED',
        },
      },
      loadBalancers: [
        {
          containerName: 'web',
          containerPort: 3000,
          targetGroupArn: webTG.ref,
        },
      ],
    });

    // ─── Dependency ordering ───────────────────────────────────────────────
    // ECS services must wait for ALB listeners + target groups to exist
    apiService.addDependency(httpListener);
    apiService.addDependency(apiTG);
    webService.addDependency(httpListener);
    webService.addDependency(webTG);
    if (httpsListener) {
      apiService.addDependency(httpsListener);
      webService.addDependency(httpsListener);
    }

    // ─── CloudWatch Alarms ─────────────────────────────────────────────────
    // These five alarms catch the operational failures we hit in May 2026:
    //   - OrphanFargateTaskAlarm: zombie one-off `aws ecs run-task` invocations
    //     (RunningTaskCount > 3 for 1h). Reference incident: 2026-05-15/17 saw
    //     13 zombies accumulate, costing ~$510/mo until cleanup.
    //   - {Api,Web}NoHealthyHostsAlarm: target group reports 0 healthy hosts
    //     for 3min. Catches ECS service replacement gone bad.
    //   - {Api,Web}UnhealthyHostsAlarm: stale unhealthy ENI registrations
    //     (orphan task IPs, AZ asymmetry like the 2026-05-24 ALB subnet issue).
    //
    // IMPORTANT: These alarms AND the SNS topic ALREADY EXIST in AWS (created
    // via CLI on 2026-05-24 because of the CDK drift discovered then).
    // Running `cdk deploy` will fail with "alarm already exists" until
    // someone runs `cdk import` to adopt them under CDK management. Until
    // then, see DEPLOYMENT_STATUS.md → "CloudWatch Alarms" for the CLI
    // commands. The SNS topic has at least one email subscription (manually
    // confirmed); CDK does not manage subscriptions either.
    //
    // Requires Container Insights to be enabled on the cluster:
    //   aws ecs update-cluster-settings --cluster spotterspace-cluster \
    //     --settings name=containerInsights,value=enabled --region us-east-1
    const alarmTopic = sns.Topic.fromTopicArn(
      this,
      'AlarmTopic',
      `arn:aws:sns:${this.region}:654654553862:spotterspace-${stage}-alarms`,
    );
    const alarmAction = new cwActions.SnsAction(alarmTopic);

    const orphanFargateTaskAlarm = new cloudwatch.Alarm(this, 'OrphanFargateTaskAlarm', {
      alarmName: `spotterspace-${stage}-orphan-fargate-tasks`,
      alarmDescription:
        'ECS cluster has more than 3 running tasks for 1h — likely orphaned one-off `aws ecs run-task` invocations. Check `aws ecs list-tasks` and stop any task whose Group does not start with "service:".',
      // Use TaskCount (cluster-level) not RunningTaskCount (per-service only,
      // which would never trigger because zombies don't belong to a service).
      metric: new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'TaskCount',
        dimensionsMap: { ClusterName: 'spotterspace-cluster' },
        statistic: 'Maximum',
        period: cdkDuration.minutes(5),
      }),
      threshold: 3,
      evaluationPeriods: 12, // 12 × 5min = 1h
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    orphanFargateTaskAlarm.addAlarmAction(alarmAction);
    orphanFargateTaskAlarm.addOkAction(alarmAction);

    // CloudWatch's LoadBalancer dimension expects the "full name" form
    // (app/<name>/<id>), which we extract from the ARN since fromLookup'd
    // ALBs don't expose loadBalancerFullName.
    const albFullName = albArnStr.split(':loadbalancer/')[1];
    if (!albFullName) {
      throw new Error(`Could not extract ALB full name from ARN: ${albArnStr}`);
    }
    for (const [name, tg] of [
      ['Api', apiTG],
      ['Web', webTG],
    ] as const) {
      const noHealthyAlarm = new cloudwatch.Alarm(this, `${name}NoHealthyHostsAlarm`, {
        alarmName: `spotterspace-${stage}-${name.toLowerCase()}-no-healthy-hosts`,
        alarmDescription: `${name} target group has zero healthy hosts. Check ECS service events and ALB target health.`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApplicationELB',
          metricName: 'HealthyHostCount',
          dimensionsMap: {
            LoadBalancer: albFullName,
            TargetGroup: tg.attrTargetGroupFullName,
          },
          statistic: 'Minimum',
          period: cdkDuration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      noHealthyAlarm.addAlarmAction(alarmAction);
      noHealthyAlarm.addOkAction(alarmAction);

      const unhealthyAlarm = new cloudwatch.Alarm(this, `${name}UnhealthyHostsAlarm`, {
        alarmName: `spotterspace-${stage}-${name.toLowerCase()}-unhealthy-hosts`,
        alarmDescription: `${name} target group has unhealthy hosts persisting for 15min. Check ALB target health and recent task replacements.`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApplicationELB',
          metricName: 'UnHealthyHostCount',
          dimensionsMap: {
            LoadBalancer: albFullName,
            TargetGroup: tg.attrTargetGroupFullName,
          },
          statistic: 'Maximum',
          period: cdkDuration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 3, // 3 × 5min = 15min
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      unhealthyAlarm.addAlarmAction(alarmAction);
      unhealthyAlarm.addOkAction(alarmAction);
    }

    // ─── Outputs ───────────────────────────────────────────────────────────
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ApiServiceArn', { value: apiService.attrServiceArn });
    new CfnOutput(this, 'WebServiceArn', { value: webService.attrServiceArn });
    new CfnOutput(this, 'ApiTaskDefinitionArn', { value: apiTaskDef.ref });
    new CfnOutput(this, 'WebTaskDefinitionArn', { value: webTaskDef.ref });
    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'AlbArn', { value: alb.loadBalancerArn });
    new CfnOutput(this, 'Stage', { value: stage });
  }
}

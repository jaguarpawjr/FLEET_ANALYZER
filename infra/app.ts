#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as patterns from "aws-cdk-lib/aws-ecs-patterns";
import { Construct } from "constructs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class FleetAnalyticsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const bucket = new s3.Bucket(this, "ProcessedAnalytics", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const vpc = new ec2.Vpc(this, "FleetVpc", { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, "FleetCluster", { vpc });
    cluster.addDefaultCloudMapNamespace({ name: "fleet.local" });
    const apiImage = new ecrAssets.DockerImageAsset(this, "ApiImage", { directory: repoRoot, file: "Dockerfile.api" });
    const apiLogs = new logs.LogGroup(this, "ApiLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
    const api = new patterns.ApplicationLoadBalancedFargateService(this, "FleetApi", {
      cluster, cpu: 512, memoryLimitMiB: 1024, desiredCount: 1,
      cloudMapOptions: { name: "api" },
      publicLoadBalancer: true, taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 100, maxHealthyPercent: 200, circuitBreaker: { rollback: true },
      taskImageOptions: {
        image: ecs.ContainerImage.fromDockerImageAsset(apiImage),
        containerPort: 3000,
        environment: { PORT: "3000", OUTPUT_DIR: "/app/data/processed", PROCESSED_BUCKET: bucket.bucketName },
        logDriver: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: "api" })
      },
      healthCheckGracePeriod: Duration.seconds(60)
    });
    api.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject"],
      resources: [bucket.arnForObjects("processed/*")]
    }));
    const dashboardImage = new ecrAssets.DockerImageAsset(this, "DashboardImage", { directory: repoRoot, file: "Dockerfile.dashboard" });
    const dashboardLogs = new logs.LogGroup(this, "DashboardLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
    const dashboard = new patterns.ApplicationLoadBalancedFargateService(this, "FleetDashboard", {
      cluster, cpu: 256, memoryLimitMiB: 512, desiredCount: 1,
      publicLoadBalancer: true, taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 100, maxHealthyPercent: 200, circuitBreaker: { rollback: true },
      taskImageOptions: {
        image: ecs.ContainerImage.fromDockerImageAsset(dashboardImage),
        containerPort: 4173,
        environment: { API_ORIGIN: "http://api.fleet.local:3000" },
        logDriver: ecs.LogDrivers.awsLogs({ logGroup: dashboardLogs, streamPrefix: "dashboard" })
      }
    });
    api.service.connections.allowFrom(dashboard.service, ec2.Port.tcp(3000), "Dashboard API proxy");
    api.targetGroup.configureHealthCheck({ path: "/zones" });
    dashboard.targetGroup.configureHealthCheck({ path: "/" });
    new cdk.CfnOutput(this, "ApiUrl", { value: `http://${api.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, "DashboardUrl", { value: `http://${dashboard.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, "ProcessedDataBucket", { value: bucket.bucketName });
  }
}

const app = new cdk.App();
new FleetAnalyticsStack(app, "FleetAnalyticsStack");

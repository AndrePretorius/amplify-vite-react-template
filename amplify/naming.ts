import { Annotations, Aspects, Aws, CfnResource, type IAspect, type Stack } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/**
 * Gives every named AWS resource in the backend a readable physical name:
 *
 *   <project>-<branch>-<what-it-is>          e.g. amplify-vite-react-template-main-user-pool
 *   <project>-sandbox-<id>-<what-it-is>      for `ampx sandbox`
 *
 * Amplify/CDK otherwise generates names like
 * `amplify-d3fghknxb8a3fv-ma-amplifydataamplifycodege-w1lcdvyj1xhk`.
 *
 * Changing a physical name makes CloudFormation REPLACE the resource, so apply
 * this to a fresh backend or accept that the data in the old resources is lost.
 */

/** Name of this project; the first part of every resource name. */
const PROJECT = 'amplify-vite-react-template';

/**
 * Maps a construct path (without the root stack id) to a short label. First match wins.
 * `$1`.. are regex groups, `$stack` is the top-level stack the resource lives in (data, storage, ...).
 * Anything not listed here falls back to a label derived from the path, so resources
 * added later (functions, storage, ...) still get a readable name.
 */
const LABELS: [RegExp, string][] = [
  // Functions defined with defineFunction()
  [/^function\/([^/]+?)(?:-lambda)?\/ServiceRole\//, '$1-role'],
  [/^function\/([^/]+?)(?:-lambda)?\//, '$1'],

  // Buckets defined with defineStorage()
  [/^storage\/([^/]+)\/Bucket\//, '$1'],

  // Amplify hosting
  [/AmplifyBranchLinker\/CustomResourceLambda\/ServiceRole\//, 'branch-linker-role'],
  [/AmplifyBranchLinker\/CustomResourceLambda\//, 'branch-linker'],
  [/AmplifyBranchLinker\/CustomResourceProvider\/framework-onEvent\/ServiceRole\//, 'branch-linker-provider-role'],
  [/AmplifyBranchLinker\/CustomResourceProvider\/framework-onEvent\//, 'branch-linker-provider'],

  // Auth
  [/^auth\/amplifyAuth\/UserPool\//, 'user-pool'],
  [/^auth\/amplifyAuth\/UserPoolAppClient\//, 'web-client'],
  [/^auth\/amplifyAuth\/IdentityPool\//, 'identity-pool'],
  [/^auth\/amplifyAuth\/authenticatedUserRole\//, 'authenticated-role'],
  [/^auth\/amplifyAuth\/unauthenticatedUserRole\//, 'unauthenticated-role'],

  // Data
  [/amplifyData\/GraphQLAPI\//, 'api'],
  [/amplifyData\/([^/]+)\/\1IAMRole\//, '$1-table-role'],
  [/amplifyData\/([^/]+)\/\1Table\//, '$1'],
  [/AmplifyTableManager\/AmplifyManagedTableOnEventRole\//, 'table-manager-on-event-role'],
  [/AmplifyTableManager\/AmplifyManagedTableIsCompleteRole\//, 'table-manager-is-complete-role'],
  [/AmplifyTableManager\/TableManagerCustomProvider\/framework-onEvent\//, 'table-manager-on-event'],
  [/AmplifyTableManager\/TableManagerCustomProvider\/framework-isComplete\//, 'table-manager-is-complete'],
  [/AmplifyTableManager\/AmplifyTableWaiterStateMachine\/Role\//, 'table-waiter-role'],
  [/AmplifyTableManager\/AmplifyTableWaiterStateMachine\//, 'table-waiter'],
  [/AmplifyCodegenAssetsBucket\//, 'codegen-assets'],
  [/AmplifyCodegenAssetsDeployment\/AwsCliLayer\//, 'codegen-assets-aws-cli'],
  [/^data\/modelIntrospectionSchemaBucket\//, 'model-schema'],
  [/^data\/modelIntrospectionSchemaBucketDeployment\/AwsCliLayer\//, 'model-schema-aws-cli'],

  // CDK helper functions; every stack (data, storage, ...) gets its own copy, so $stack keeps them apart
  [/Custom::S3AutoDeleteObjectsCustomResourceProvider\/Role\//, '$stack-s3-auto-delete-role'],
  [/Custom::S3AutoDeleteObjectsCustomResourceProvider\/Handler\//, '$stack-s3-auto-delete'],
  [/Custom::CDKBucketDeployment[^/]*\/ServiceRole\//, '$stack-bucket-deployment-role'],
  [/Custom::CDKBucketDeployment[^/]*\//, '$stack-bucket-deployment'],
];

/** CloudFormation type -> template property holding the physical name, and the max length AWS allows. */
const NAME_PROPERTIES: Record<string, { property: string; maxLength: number; accountSuffix?: boolean }> = {
  'AWS::S3::Bucket': { property: 'BucketName', maxLength: 63, accountSuffix: true }, // bucket names are global
  'AWS::Lambda::Function': { property: 'FunctionName', maxLength: 64 },
  'AWS::Lambda::LayerVersion': { property: 'LayerName', maxLength: 64 },
  'AWS::IAM::Role': { property: 'RoleName', maxLength: 64 },
  'AWS::Cognito::UserPool': { property: 'UserPoolName', maxLength: 128 },
  'AWS::Cognito::UserPoolClient': { property: 'ClientName', maxLength: 128 },
  'AWS::Cognito::IdentityPool': { property: 'IdentityPoolName', maxLength: 128 },
  'AWS::AppSync::GraphQLApi': { property: 'Name', maxLength: 65 },
  'AWS::StepFunctions::StateMachine': { property: 'StateMachineName', maxLength: 80 },
  'Custom::AmplifyDynamoDBTable': { property: 'tableName', maxLength: 255 },
};

/** Characters in an AWS account id, used to budget the length of account-suffixed names. */
const ACCOUNT_ID_LENGTH = 12;

/** Short, stable (FNV-1a) hash used to keep shortened or fallback names unique. */
const hash = (value: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
};

const kebab = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

/** `main` -> `main`, `feature/login` -> `feature-login` */
const sanitize = (value: string) => kebab(value) || 'default';

const labelFor = (rawPath: string, resourceType: string): string => {
  const path = `${rawPath}/`; // so every rule can end with "/", whether or not the construct has children
  for (const [pattern, label] of LABELS) {
    const match = pattern.exec(path);
    if (match) {
      return kebab(
        label.replace('$stack', path.split('/')[0]).replace(/\$(\d)/g, (_, i) => match[Number(i)] ?? ''),
      );
    }
  }

  // Fallback for resources added later: last meaningful path segment, made unique by a path hash.
  const noise = new Set(['Resource', 'Default', 'ServiceRole', 'Role', 'lambda']);
  const segments = rawPath.split('/').filter((segment) => !noise.has(segment));
  const role = resourceType === 'AWS::IAM::Role' ? '-role' : '';
  return `${kebab(segments[segments.length - 1] ?? 'resource')}${role}-${hash(rawPath)}`;
};

/**
 * `<prefix>-<label>`. When that exceeds `maxLength` the prefix (never the label) is shortened to
 * `<start of prefix>-<hash of prefix>`, so all resources of one branch still share the same stem.
 */
const fit = (prefix: string, label: string, maxLength: number) => {
  const name = `${prefix}-${label}`;
  if (name.length <= maxLength) return name;
  const stemHash = hash(prefix);
  const room = maxLength - label.length - stemHash.length - 2;
  return `${prefix.slice(0, Math.max(room, 1)).replace(/-+$/, '')}-${stemHash}-${label}`;
};

class ReadableNames implements IAspect {
  private readonly used = new Map<string, string>();

  constructor(private readonly prefix: string) {}

  visit(node: IConstruct): void {
    if (!CfnResource.isCfnResource(node)) return;
    const target = NAME_PROPERTIES[node.cfnResourceType];
    if (!target) return;

    const path = node.node.path.split('/').slice(1).join('/'); // drop the root stack id
    const label = labelFor(path, node.cfnResourceType);
    const budget = target.maxLength - (target.accountSuffix ? ACCOUNT_ID_LENGTH + 1 : 0);
    const name = fit(this.prefix, label, budget);

    const key = `${node.cfnResourceType}:${name}`;
    const clash = this.used.get(key);
    if (clash && clash !== path) {
      Annotations.of(node).addError(`Readable name "${name}" is already used by ${clash}; add a rule to LABELS in amplify/naming.ts.`);
      return;
    }
    this.used.set(key, path);

    node.addPropertyOverride(target.property, target.accountSuffix ? `${name}-${Aws.ACCOUNT_ID}` : name);
  }
}

/** Applies readable physical names to every resource in the backend `stack` (including nested stacks). */
export const applyReadableNames = (stack: Stack) => {
  const type = stack.node.tryGetContext('amplify-backend-type') as string | undefined;
  const name = stack.node.tryGetContext('amplify-backend-name') as string | undefined;
  const prefix = [PROJECT, type === 'sandbox' ? 'sandbox' : undefined, name && sanitize(name)]
    .filter(Boolean)
    .join('-');
  Aspects.of(stack).add(new ReadableNames(prefix));
};

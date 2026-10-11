import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { applyReadableNames } from './naming';

const backend = defineBackend({
  auth,
  data,
});

// Readable names (amplify-vite-react-template-main-...) for buckets, lambdas, roles, etc.
applyReadableNames(backend.stack);

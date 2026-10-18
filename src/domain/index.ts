// Registers the built-in domain packs. Import this module for its side effect wherever a pack is looked up.
import './procurement.ts';
import './vendor-onboarding.ts';
import './real-estate.ts';

export { domainFor, outcomeOf, registeredDomains, termOf } from './pack.ts';

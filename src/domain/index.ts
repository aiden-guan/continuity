// Registers the built-in domain packs. Import this module for its side effect wherever a pack is looked up.
import './procurement.ts';
import './vendor-onboarding.ts';
import './freight.ts';
import './hotel.ts';
import './finance.ts';
import './legal.ts';

export { domainFor, registeredDomains } from './pack.ts';

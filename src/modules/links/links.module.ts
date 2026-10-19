import { env } from "../../config/env.js";
import { HeuristicReputationProvider, ReputationChain } from "./link.reputation.js";
import { BlockedDomainRepository, LinkRepository } from "./link.repository.js";
import { DEFAULT_LINK_CONFIG, LinkService } from "./link.service.js";

/**
 * Composition root for links. To add a reputation source (a free feed, Google Web Risk), implement
 * `LinkReputationProvider` and add it to the chain below; nothing else changes (IR-SW-6).
 */
let service: LinkService | undefined;
export const getLinkService = () =>
  (service ??= new LinkService(
    new LinkRepository(),
    new BlockedDomainRepository(),
    new ReputationChain([new HeuristicReputationProvider()]),
    {
      ...DEFAULT_LINK_CONFIG,
      host: env.LINK_HOST,
      codeLength: env.LINK_CODE_LENGTH,
      recheckMs: env.LINK_RECHECK_HOURS * 3_600_000,
    },
  ));

import { AgentRepository, agentRepository, AgentDirectoryQueryParams } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import {
  DeliveryAgencyRepository,
  AgencyListQueryParams,
} from '../../../delivery/delivery-agency.repository';
import { FileRepositoryMongo } from '../../../catalog/repositories/mongo/file.repository.mongo';
import { resolveFileDetails } from '../../../catalog/read-models/file-detail.resolver';
import { getStorageProvider, IStorageProvider } from '../../../../core/storage';
import { VendorAgencyListItemDto, VendorAgencyMapper } from '../../../vendor/dto/vendor-agency.dto';
import {
  AgentDirectoryItemDto,
  AgentDirectoryMapper,
  DirectoryContractRefDto,
  DirectoryListMeta,
  WithContractRef,
} from '../../dto/agent-directory.dto';
import {
  IAgentAgencyContract,
  LIVE_CONTRACT_STATUSES,
} from '../../models/agent-agency-membership.model';

/** The agent-facing subset of the agency browse filters. */
export type AgencyDirectoryQueryParams = Pick<
  AgencyListQueryParams,
  'search' | 'region' | 'hq_city' | 'page' | 'limit'
>;

/**
 * AgentDirectoryService — discovery for both halves of the agent↔agency
 * handshake.
 *
 * Deliberately separate from AgentContractService: that service is the contract
 * FSM and should stay one thing, and this one needs the file-repository and
 * storage-provider dependencies it has no use for. Same split as
 * ConnectionService's browse methods sitting apart from its transition methods
 * — except here the read side is the separate class rather than the other way
 * round, because the contract service is much the larger of the two.
 *
 * Both methods follow the vendor↔agency browse shape
 * (ConnectionService.browseVendorsForAgency): run the counterparty query and
 * the contract lookup in parallel, batch-resolve the logos/avatars, then
 * left-join the caller's contract onto each row so the client can render
 * Request / Pending / Connected without a second call.
 */
export class AgentDirectoryService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly contracts: AgentContractRepository = agentContractRepository,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly files: FileRepositoryMongo = new FileRepositoryMongo(),
    private readonly storage: IStorageProvider = getStorageProvider()
  ) {}

  /**
   * Pick the contract that describes the caller's standing with a counterparty.
   *
   * A pair accumulates one row per contract here — unlike the vendor↔agency
   * connection, which reuses a single document forever — so "the contract" has
   * to be chosen. The live one wins; failing that the most recent terminal one,
   * which is what lets the UI say "you rejected this agency last month" rather
   * than showing a blank slate. Rows arrive newest-first, so the fallback is
   * simply the first match.
   */
  private pickContract(rows: IAgentAgencyContract[]): DirectoryContractRefDto | null {
    const chosen = rows.find((c) => LIVE_CONTRACT_STATUSES.includes(c.status)) ?? rows[0];
    if (!chosen) return null;

    return {
      id: chosen._id.toString(),
      status: chosen.status,
      initiatedBy: chosen.origin === 'join_request' ? 'agent' : 'agency',
      isPrimary: chosen.is_primary,
    };
  }

  private static meta(total: number, page: number, limit: number): DirectoryListMeta {
    return { total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Group contract rows by the counterparty id, preserving newest-first order. */
  private static groupBy(
    rows: IAgentAgencyContract[],
    key: (row: IAgentAgencyContract) => string
  ): Map<string, IAgentAgencyContract[]> {
    const grouped = new Map<string, IAgentAgencyContract[]>();
    for (const row of rows) {
      const id = key(row);
      const bucket = grouped.get(id);
      if (bucket) bucket.push(row);
      else grouped.set(id, [row]);
    }
    return grouped;
  }

  // ─── Agency → agents ────────────────────────────────────────────────────────

  async browseAgentsForAgency(
    agencyId: string,
    params: AgentDirectoryQueryParams
  ): Promise<{ agents: WithContractRef<AgentDirectoryItemDto>[]; meta: DirectoryListMeta }> {
    const { agents, total } = await this.agents.findAvailableForAgencies(params);
    const agentIds = agents.map((a) => a._id.toString());

    // Scoped to this page's ids, not the agency's whole contract set.
    const [contracts, avatarByFileId] = await Promise.all([
      this.contracts.findForAgencyAndAgents(agencyId, agentIds),
      resolveFileDetails(
        agents.map((a) => a.avatar_file_id?.toString() ?? null),
        this.files,
        this.storage
      ),
    ]);

    const byAgentId = AgentDirectoryService.groupBy(contracts, (c) => c.agent_id.toString());

    const items = agents.map((agent) => {
      const fileId = agent.avatar_file_id?.toString();
      const avatar = fileId ? avatarByFileId.get(fileId) ?? null : null;
      const dto = AgentDirectoryMapper.toListItemDto(agent, avatar);
      return { ...dto, contract: this.pickContract(byAgentId.get(dto.id) ?? []) };
    });

    return { agents: items, meta: AgentDirectoryService.meta(total, params.page, params.limit) };
  }

  // ─── Agent → agencies ───────────────────────────────────────────────────────

  /**
   * Reuses the agency query and list-item mapper the vendor browse already
   * uses. The hard filter it applies (active + onboarding complete) is exactly
   * the right one here too, and the vendor-only policy filters simply go
   * unpassed. The `Vendor`-prefixed names are historical — see the note on
   * DeliveryAgencyRepository.findAvailableForVendors.
   */
  async browseAgenciesForAgent(
    agentId: string,
    params: AgencyDirectoryQueryParams
  ): Promise<{ agencies: WithContractRef<VendorAgencyListItemDto>[]; meta: DirectoryListMeta }> {
    const { agencies, total } = await this.agencies.findAvailableForVendors(
      params as AgencyListQueryParams
    );
    const agencyIds = agencies.map((a) => a._id.toString());

    const [contracts, logoByFileId] = await Promise.all([
      this.contracts.findForAgentAndAgencies(agentId, agencyIds),
      resolveFileDetails(
        agencies.map((a) => a.magazin?.logo_file_id?.toString() ?? null),
        this.files,
        this.storage
      ),
    ]);

    const byAgencyId = AgentDirectoryService.groupBy(contracts, (c) => c.agency_id.toString());

    const items = agencies.map((agency) => {
      const fileId = agency.magazin?.logo_file_id?.toString();
      const logo = fileId ? logoByFileId.get(fileId) ?? null : null;
      const dto = VendorAgencyMapper.toListItemDto(agency, agency.magazin ?? null, logo);
      return { ...dto, contract: this.pickContract(byAgencyId.get(dto.id) ?? []) };
    });

    return { agencies: items, meta: AgentDirectoryService.meta(total, params.page, params.limit) };
  }
}

export const agentDirectoryService = new AgentDirectoryService();

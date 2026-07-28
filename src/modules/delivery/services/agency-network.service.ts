import { VendorRepository } from '../../vendors/vendor.repository';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { PaginationOptions, Page } from '../../../core/repositories/base.repository';

/**
 * Read-only "who's connected to me" views for an agency:
 * - vendors who set this agency as their default (requirement #7)
 * - products this agency is set up to deliver, explicit override + inherited
 *   via a vendor default (requirement #8)
 *
 * Neither view lets the agency change anything — vendors/products are owned
 * and configured on the vendor side.
 */
export class AgencyNetworkService {
    private vendorRepo: VendorRepository;
    private productRepo: ProductRepositoryMongo;

    constructor() {
        this.vendorRepo = new VendorRepository();
        this.productRepo = new ProductRepositoryMongo();
    }

    async listVendorsUsingAsDefault(agencyId: string, pagination: PaginationOptions): Promise<Page<any>> {
        const page = await this.vendorRepo.findByDefaultAgency(agencyId, pagination);
        return {
            data: page.data.map(v => ({
                id: v._id.toString(),
                businessName: v.store?.name ?? '',
                displayName: v.display_name ?? null,
                email: v.email ?? null,
                phone: v.phone ?? null,
                status: v.status,
                businessAddress: v.business_addresses?.[0] ? {
                    label: v.business_addresses[0].label,
                    city: v.business_addresses[0].city,
                    state: v.business_addresses[0].state,
                } : null,
            })),
            meta: page.meta,
        };
    }

    async listDeliverableProducts(agencyId: string, pagination: PaginationOptions): Promise<Page<any>> {
        const vendorIds = await this.vendorRepo.findVendorIdsByDefaultAgency(agencyId);
        const page = await this.productRepo.findByEffectiveDeliveryAgency(agencyId, vendorIds, pagination);

        return {
            data: page.data.map(p => ({
                id: p.id,
                vendorId: p.vendorId,
                title: p.title,
                status: p.status,
                category: p.category,
                source: p.delivery?.agencyId ? 'own_override' : 'vendor_default',
            })),
            meta: page.meta,
        };
    }
}

export const agencyNetworkService = new AgencyNetworkService();

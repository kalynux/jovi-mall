export interface IMapper<DomainEntity, PersistenceEntity> {
  toDomain(persistence: PersistenceEntity): DomainEntity;
  toPersistence(domain: DomainEntity): PersistenceEntity;
}

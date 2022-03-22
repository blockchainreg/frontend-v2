import {
  UserGuageShare,
  UserGuageSharesResponse,
  LiquidityGauge as TLiquidityGauge
} from '@/components/contextual/pages/pools/types';
import useGraphQuery, { subgraphs } from '@/composables/queries/useGraphQuery';
import usePoolsQuery from '@/composables/queries/usePoolsQuery';
import useUserPoolsQuery from '@/composables/queries/useUserPoolsQuery';
import useTokens from '@/composables/useTokens';
import symbolKeys from '@/constants/symbol.keys';
import { LiquidityGauge } from '@/services/balancer/contracts/contracts/liquidity-gauge';
import { configService } from '@/services/config/config.service';
import useWeb3 from '@/services/web3/useWeb3';
import { Contract } from '@ethersproject/contracts';
import { getAddress } from '@ethersproject/address';

import { formatUnits, parseUnits } from 'ethers/lib/utils';
import { Interface } from '@ethersproject/abi';
import GaugeFactoryABI from '@/lib/abi/GaugeFactory.json';

import {
  provide,
  computed,
  InjectionKey,
  reactive,
  ref,
  defineComponent,
  h,
  ComputedRef,
  Ref
} from 'vue';
import { DecoratedPool } from '@/services/balancer/subgraph/types';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { useQuery } from 'vue-query';
import { QueryObserverResult, RefetchOptions } from 'react-query';
import { BalancerTokenAdmin } from '@/services/balancer/contracts/contracts/token-admin';
import { GaugeController } from '@/services/balancer/contracts/contracts/gauge-controller';
import { getUnixTime } from 'date-fns';
import { mapValues, times, uniq } from 'lodash';
import { bnum } from '@/lib/utils';

/**
 * TYPES
 */
export type StakingProvider = {
  userGaugeShares: ComputedRef<UserGuageShare[]>;
  userLiquidityGauges: ComputedRef<TLiquidityGauge[]>;
  stakedShares: Ref<string>;
  stakedPools: Ref<DecoratedPool[]>;
  isLoadingStakedPools: Ref<boolean>;
  isStakeDataIdle: Ref<boolean>;
  isLoading: Ref<boolean>;
  isLoadingStakingData: Ref<boolean>;
  isLoadingStakedShares: Ref<boolean>;
  isStakedSharesIdle: Ref<boolean>;
  isRefetchingStakedShares: Ref<boolean>;
  isLoadingPoolEligibility: Ref<boolean>;
  isPoolEligibleForStaking: Ref<boolean>;
  isStakedPoolsQueryEnabled: Ref<boolean>;
  refetchStakedShares: Ref<() => void>;
  poolPayouts: any;
  getGaugeAddress: (poolAddress: string) => Promise<string>;
  stakeBPT: () => Promise<TransactionResponse>;
  unstakeBPT: () => Promise<TransactionResponse>;
  getStakedShares: () => Promise<string>;
  setPoolAddress: (address: string) => void;
  refetchStakingData: Ref<
    (options?: RefetchOptions) => Promise<QueryObserverResult>
  >;
};

/**
 * CONTRACTS
 */
const tokenAdmin = new BalancerTokenAdmin(
  configService.network.addresses.tokenAdmin
);
const controller = new GaugeController(
  configService.network.addresses.gaugeController
);

/**
 * SETUP
 */
export const StakingProviderSymbol: InjectionKey<StakingProvider> = Symbol(
  symbolKeys.Providers.App
);

export default defineComponent({
  props: {
    poolAddress: {
      type: String
    }
  },
  setup(props) {
    /**
     * STATE
     */
    const _poolAddress = ref();

    /**
     * COMPOSABLES
     */
    const { getProvider, account } = useWeb3();
    const { balanceFor, priceFor } = useTokens();

    /** QUERY ARGS */
    const userPoolIds = computed(() => {
      return userPools.value.map(pool => pool.id);
    });

    const poolAddress = computed(() => {
      return _poolAddress.value || props.poolAddress;
    });
    const isStakingQueryEnabled = computed(() => userPoolIds.value.length > 0);
    const isStakedSharesQueryEnabled = computed(
      () => !!poolAddress.value && poolAddress.value != ''
    );

    /**
     * QUERIES
     */
    const { data: userPoolsResponse } = useUserPoolsQuery();

    const userPools = computed(() => userPoolsResponse.value?.pools || []);

    const {
      data: stakingData,
      isLoading: isLoadingStakingData,
      isIdle: isStakeDataIdle,
      refetch: refetchStakingData
    } = useGraphQuery<UserGuageSharesResponse>(
      subgraphs.gauge,
      ['staking', 'data', { account, userPoolIds }],
      () => ({
        gaugeShares: {
          __args: {
            where: { user: account.value.toLowerCase() }
          },
          balance: true,
          gauge: {
            poolId: true,
            id: true
          }
        },
        liquidityGauges: {
          __args: {
            where: {
              poolId_in: userPoolIds.value
            }
          },
          poolId: true,
          id: true
        }
      }),
      reactive({
        refetchOnWindowFocus: false,
        enabled: isStakingQueryEnabled
      })
    );

    const {
      data: stakedSharesResponse,
      isLoading: isLoadingStakedShares,
      isIdle: isStakedSharesIdle,
      isRefetching: isRefetchingStakedShares,
      refetch: refetchStakedShares
    } = useQuery<string>(
      ['staking', 'pool', 'shares'],
      () => getStakedShares(),
      reactive({
        enabled: isStakedSharesQueryEnabled,
        refetchOnWindowFocus: false
      })
    );

    const {
      data: poolEligibilityResponse,
      isLoading: isLoadingPoolEligibility
    } = useGraphQuery<{ liquidityGauges: TLiquidityGauge[] }>(
      subgraphs.gauge,
      ['pool', 'eligibility', { poolAddress: poolAddress.value }],
      () => ({
        liquidityGauges: {
          __args: {
            where: {
              poolAddress: (poolAddress.value || '').toLowerCase()
            }
          },
          id: true
        }
      }),
      reactive({
        enabled: isStakedSharesQueryEnabled,
        refetchOnWindowFocus: false
      })
    );

    const userGaugeAddresses = computed(() => {
      const stakedGauges = (stakingData.value?.gaugeShares || []).map(
        gaugeShare => gaugeShare.gauge.id
      );
      const userPoolGauges = (stakingData.value?.liquidityGauges || [])
        .map(gauge => gauge.id)
        .filter(id => id !== undefined) as string[];
      const gaugeAddresses = uniq([...stakedGauges, ...userPoolGauges]);
      return gaugeAddresses;
    });

    const {
      data: inflationRate,
      isLoading: isLoadingInflationRate
    } = useQuery(['inflation_rate'], () => tokenAdmin.getInflationRate());

    const {
      data: gaugeRelativeWeights,
      isLoading: isLoadingRelativeWeight
    } = useQuery(
      reactive([
        'pool',
        'gauge_relative_weight',
        { poolAddress, userGaugeAddresses }
      ]),
      async () => {
        const timestamp = getUnixTime(new Date());
        const result = await controller.getRelativeWeights(
          userGaugeAddresses.value,
          timestamp
        );
        console.log('res', result);
        return result;
      }
    );

    /**
     * COMPUTED
     * Need to wrap the extracted query response vars into
     * computed properties so they retain reactivity
     * when returned by this composable
     */
    const stakedShares = computed(() => stakedSharesResponse.value || '0');

    const userGaugeShares = computed(() => {
      if (!stakingData.value?.gaugeShares) return [];
      return stakingData.value.gaugeShares;
    });

    const userLiquidityGauges = computed(() => {
      if (!stakingData.value?.liquidityGauges) return [];
      return stakingData.value.liquidityGauges;
    });

    const stakedPoolIds = computed(() => {
      if (isLoadingStakingData.value || !userGaugeShares.value) return [];
      return userGaugeShares.value.map(share => {
        return share.gauge.poolId;
      });
    });

    const isPoolEligibleForStaking = computed(
      () =>
        (poolEligibilityResponse.value?.liquidityGauges || [])[0]?.id !==
        undefined
    );

    const isStakedPoolsQueryEnabled = computed(
      () => stakedPoolIds.value.length > 0
    );

    const poolPayouts = computed(() => {
      const payouts = {};
      const rate = inflationRate.value ?? '0';
      const relativeWeights = gaugeRelativeWeights.value || {};
      for (const gaugeAddress of userGaugeAddresses.value) {
        const relativeWeight = relativeWeights[gaugeAddress] || '0';
        payouts[gaugeAddress] = bnum(rate)
          .times(7)
          .times(86400)
          .times(bnum(relativeWeight));
      }
      return payouts;
    });

    const poolAprs = computed(() => {
      return mapValues(poolPayouts.value, payout =>
        bnum(payout).times(
          priceFor('0x41286Bb1D3E870f3F750eB7E1C25d7E48c8A1Ac7')
        )
      );
    });

    /** QUERY */
    const {
      data: stakedPoolsResponse,
      isLoading: isLoadingStakedPools
    } = usePoolsQuery(
      ref([]),
      reactive({
        enabled: isStakedPoolsQueryEnabled
      }),
      {
        poolIds: stakedPoolIds
      }
    );

    const isLoading = computed(
      () =>
        isLoadingStakedPools.value ||
        isLoadingStakingData.value ||
        isStakeDataIdle.value
    );

    const stakedPools = computed(
      () => stakedPoolsResponse.value?.pages[0].pools || []
    );

    /**
     * METHODS
     */
    async function stakeBPT() {
      if (!poolAddress.value) {
        throw new Error(
          `Attempted to call stake, however useStaking was initialised without a pool address.`
        );
      }
      const gaugeAddress = await getGaugeAddress(poolAddress.value);
      const gauge = new LiquidityGauge(gaugeAddress);
      const tx = await gauge.stake(
        parseUnits(balanceFor(getAddress(poolAddress.value)), 18)
      );
      return tx;
    }

    async function unstakeBPT() {
      if (!poolAddress.value) {
        throw new Error(
          `Attempted to call unstake, however useStaking was initialised without a pool address.`
        );
      }
      const gaugeAddress = await getGaugeAddress(getAddress(poolAddress.value));
      const gauge = new LiquidityGauge(gaugeAddress);
      const tx = await gauge.unstake(parseUnits(stakedShares.value || '0', 18));
      return tx;
    }

    async function getStakedShares() {
      if (!poolAddress.value) {
        throw new Error(
          `Attempted to get staked shares, however useStaking was initialised without a pool address.`
        );
      }
      const gaugeAddress = await getGaugeAddress(getAddress(poolAddress.value));
      const gauge = new LiquidityGauge(gaugeAddress);
      const balance = await gauge.balance(account.value);
      return formatUnits(balance.toString(), 18);
    }

    async function getGaugeAddress(poolAddress: string): Promise<string> {
      const gaugeInterface = new Interface(GaugeFactoryABI);
      const contract = new Contract(
        configService.network.addresses.gaugeFactory,
        gaugeInterface,
        getProvider()
      );
      const gaugeAddress = await contract.getPoolGauge(getAddress(poolAddress));
      return gaugeAddress;
    }

    function setPoolAddress(address: string) {
      _poolAddress.value = address;
    }

    provide(StakingProviderSymbol, {
      userGaugeShares,
      userLiquidityGauges,
      stakedShares,
      stakedPools,
      isLoadingStakingData,
      isLoadingStakedPools,
      isLoading,
      isLoadingStakedShares,
      isLoadingPoolEligibility,
      isStakeDataIdle,
      isStakedSharesIdle,
      isRefetchingStakedShares,
      isPoolEligibleForStaking,
      refetchStakedShares,
      isStakedPoolsQueryEnabled,
      poolPayouts,
      getGaugeAddress,
      stakeBPT,
      unstakeBPT,
      getStakedShares,
      setPoolAddress,
      refetchStakingData
    });
  },

  render() {
    return h('div', this.$slots?.default ? this.$slots.default() : []);
  }
});

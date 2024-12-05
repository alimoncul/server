import { HideoutHelper } from "@spt/helpers/HideoutHelper";
import { InventoryHelper } from "@spt/helpers/InventoryHelper";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { PresetHelper } from "@spt/helpers/PresetHelper";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { QuestHelper } from "@spt/helpers/QuestHelper";
import { IPmcData } from "@spt/models/eft/common/IPmcData";
import { IBotHideoutArea } from "@spt/models/eft/common/tables/IBotBase";
import { IItem } from "@spt/models/eft/common/tables/IItem";
import { IStageRequirement } from "@spt/models/eft/hideout/IHideoutArea";
import { IHideoutCircleOfCultistProductionStartRequestData } from "@spt/models/eft/hideout/IHideoutCircleOfCultistProductionStartRequestData";
import { IRequirement, IRequirementBase } from "@spt/models/eft/hideout/IHideoutProduction";
import { IItemEventRouterResponse } from "@spt/models/eft/itemEvent/IItemEventRouterResponse";
import { IAcceptedCultistReward } from "@spt/models/eft/profile/ISptProfile";
import { BaseClasses } from "@spt/models/enums/BaseClasses";
import { ConfigTypes } from "@spt/models/enums/ConfigTypes";
import { HideoutAreas } from "@spt/models/enums/HideoutAreas";
import { ItemTpl } from "@spt/models/enums/ItemTpl";
import { QuestStatus } from "@spt/models/enums/QuestStatus";
import { SkillTypes } from "@spt/models/enums/SkillTypes";
import { ICultistCircleSettings, IDirectRewardSettings, IHideoutConfig } from "@spt/models/spt/config/IHideoutConfig";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { EventOutputHolder } from "@spt/routers/EventOutputHolder";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { DatabaseService } from "@spt/services/DatabaseService";
import { ItemFilterService } from "@spt/services/ItemFilterService";
import { SeasonalEventService } from "@spt/services/SeasonalEventService";
import { HashUtil } from "@spt/utils/HashUtil";
import { RandomUtil } from "@spt/utils/RandomUtil";
import { TimeUtil } from "@spt/utils/TimeUtil";
import { ICloner } from "@spt/utils/cloners/ICloner";
import { inject, injectable } from "tsyringe";

@injectable()
export class CircleOfCultistService {
    protected static circleOfCultistSlotId = "CircleOfCultistsGrid1";
    protected hideoutConfig: IHideoutConfig;

    constructor(
        @inject("PrimaryLogger") protected logger: ILogger,
        @inject("TimeUtil") protected timeUtil: TimeUtil,
        @inject("PrimaryCloner") protected cloner: ICloner,
        @inject("EventOutputHolder") protected eventOutputHolder: EventOutputHolder,
        @inject("RandomUtil") protected randomUtil: RandomUtil,
        @inject("HashUtil") protected hashUtil: HashUtil,
        @inject("ItemHelper") protected itemHelper: ItemHelper,
        @inject("PresetHelper") protected presetHelper: PresetHelper,
        @inject("ProfileHelper") protected profileHelper: ProfileHelper,
        @inject("InventoryHelper") protected inventoryHelper: InventoryHelper,
        @inject("HideoutHelper") protected hideoutHelper: HideoutHelper,
        @inject("QuestHelper") protected questHelper: QuestHelper,
        @inject("DatabaseService") protected databaseService: DatabaseService,
        @inject("ItemFilterService") protected itemFilterService: ItemFilterService,
        @inject("SeasonalEventService") protected seasonalEventService: SeasonalEventService,
        @inject("ConfigServer") protected configServer: ConfigServer,
    ) {
        this.hideoutConfig = this.configServer.getConfig(ConfigTypes.HIDEOUT);
    }

    /**
     * Start a sacrifice event
     * Generate rewards
     * Delete sacrificed items
     * @param sessionId Session id
     * @param pmcData Player profile doing sacrifice
     * @param request Client request
     * @returns IItemEventRouterResponse
     */
    public startSacrifice(
        sessionId: string,
        pmcData: IPmcData,
        request: IHideoutCircleOfCultistProductionStartRequestData,
    ): IItemEventRouterResponse {
        const cultistCircleStashId = pmcData.Inventory.hideoutAreaStashes[HideoutAreas.CIRCLE_OF_CULTISTS];

        // `cultistRecipes` just has single recipeId
        const cultistCraftData = this.databaseService.getHideout().production.cultistRecipes[0];
        const sacrificedItems: IItem[] = this.getSacrificedItems(pmcData);
        const sacrificedItemCostRoubles = sacrificedItems.reduce(
            (sum, curr) => sum + (this.itemHelper.getItemPrice(curr._tpl) ?? 0),
            0,
        );

        const rewardAmountMultiplier = this.getRewardAmountMultipler(pmcData, this.hideoutConfig.cultistCircle);

        // Get the rouble amount we generate rewards with from cost of sacrified items * above multipler
        const rewardAmountRoubles = sacrificedItemCostRoubles * rewardAmountMultiplier;

        // Check if it matches any direct swap recipes
        const directRewardsCache = this.generateSacrificedItemsCache(this.hideoutConfig.cultistCircle.directRewards);
        const directRewardSettings = this.checkForDirectReward(sessionId, sacrificedItems, directRewardsCache);
        const hasDirectReward = directRewardSettings?.reward.length > 0;

        // Get craft time and bonus status
        const craftingInfo = hasDirectReward
            ? { time: directRewardSettings.craftTimeSeconds, bonus: CircleRewardType.RANDOM }
            : this.getCircleCraftingInfo(rewardAmountRoubles);

        // Create production in pmc profile
        this.registerCircleOfCultistProduction(
            sessionId,
            pmcData,
            cultistCraftData._id,
            sacrificedItems,
            rewardAmountRoubles,
            craftingInfo.time,
        );

        const output = this.eventOutputHolder.getOutput(sessionId);

        // Remove sacrified items from circle inventory
        for (const item of sacrificedItems) {
            if (item.slotId === CircleOfCultistService.circleOfCultistSlotId) {
                this.inventoryHelper.removeItem(pmcData, item._id, sessionId, output);
            }
        }

        const rewards = hasDirectReward
            ? this.getDirectRewards(sessionId, directRewardSettings, cultistCircleStashId)
            : this.getRewardsWithinBudget(
                  this.getCultistCircleRewardPool(sessionId, pmcData, craftingInfo.bonus),
                  rewardAmountRoubles,
                  cultistCircleStashId,
              );

        // Get the container grid for cultist stash area
        const cultistStashDbItem = this.itemHelper.getItem(ItemTpl.HIDEOUTAREACONTAINER_CIRCLEOFCULTISTS_STASH_1);

        // Ensure rewards fit into container
        const containerGrid = this.inventoryHelper.getContainerSlotMap(cultistStashDbItem[1]._id);
        const canAddToContainer = this.inventoryHelper.canPlaceItemsInContainer(
            this.cloner.clone(containerGrid), // MUST clone grid before passing in as function modifies grid
            rewards,
        );

        if (canAddToContainer) {
            for (const itemToAdd of rewards) {
                this.inventoryHelper.placeItemInContainer(
                    containerGrid,
                    itemToAdd,
                    cultistCircleStashId,
                    CircleOfCultistService.circleOfCultistSlotId,
                );
                // Add item + mods to output and profile inventory
                output.profileChanges[sessionId].items.new.push(...itemToAdd);
                pmcData.Inventory.items.push(...itemToAdd);
            }
        } else {
            this.logger.error(
                `Unable to fit all: ${rewards.length} reward items into sacrifice grid, nothing will be returned`,
            );
        }

        return output;
    }

    /**
     * Create a map of the possible direct rewards, keyed by the items needed to be sacrificed
     * @param directRewards Direct rewards array from hideout config
     * @returns Map
     */
    protected generateSacrificedItemsCache(directRewards: IDirectRewardSettings[]): Map<string, IDirectRewardSettings> {
        const result = new Map<string, IDirectRewardSettings>();
        for (const rewardSettings of directRewards) {
            const key = this.hashUtil.generateMd5ForData(rewardSettings.requiredItems.join(","));
            result.set(key, rewardSettings);
        }

        return result;
    }

    /**
     * Get the reward amount multiple value based on players hideout management skill + configs rewardPriceMultiplerMinMax values
     * @param pmcData Player profile
     * @param cultistCircleSettings Circle config settings
     * @returns Reward Amount Multipler
     */
    protected getRewardAmountMultipler(pmcData: IPmcData, cultistCircleSettings: ICultistCircleSettings): number {
        // Get a randomised value to multiply the sacrificed rouble cost by
        let rewardAmountMultiplier = this.randomUtil.getFloat(
            cultistCircleSettings.rewardPriceMultiplerMinMax.min,
            cultistCircleSettings.rewardPriceMultiplerMinMax.max,
        );

        // Adjust value generated by the players hideout management skill
        const hideoutManagementSkill = this.profileHelper.getSkillFromProfile(pmcData, SkillTypes.HIDEOUT_MANAGEMENT);
        if (hideoutManagementSkill) {
            rewardAmountMultiplier *= 1 + hideoutManagementSkill.Progress / 10000; // 5100 becomes 0.51, add 1 to it, 1.51, multiply the bonus by it (e.g. 1.2 x 1.51)
        }

        return rewardAmountMultiplier;
    }

    /**
     * Register production inside player profile
     * @param sessionId Session id
     * @param pmcData Player profile
     * @param recipeId Recipe id
     * @param sacrificedItems Items player sacrificed
     * @param rewardAmountRoubles Rouble amount to reward player in items with
     * @param craftingTime How long the ritual should take
     */
    protected registerCircleOfCultistProduction(
        sessionId: string,
        pmcData: IPmcData,
        recipeId: string,
        sacrificedItems: IItem[],
        rewardAmountRoubles: number,
        craftingTime: number,
    ): void {
        // Create circle production/craft object to add to player profile
        const cultistProduction = this.hideoutHelper.initProduction(recipeId, craftingTime, false);

        // Flag as cultist circle for code to pick up later
        cultistProduction.sptIsCultistCircle = true;

        // Add items player sacrificed
        cultistProduction.GivenItemsInStart = sacrificedItems;

        // Add circle production to profile keyed to recipe id
        pmcData.Hideout.Production[recipeId] = cultistProduction;
    }

    /**
     * Get the circle craft time as seconds, value is based on reward item value
     * And get the bonus status to determine what tier of reward is given
     * @param rewardAmountRoubles Value of rewards in roubles
     * @returns craft time seconds and bonus status
     */
    protected getCircleCraftingInfo(rewardAmountRoubles: number): ICraftDetails {
        // Edge case, check if override exists
        if (this.hideoutConfig.cultistCircle.craftTimeOverride !== -1) {
            return { time: this.hideoutConfig.cultistCircle.craftTimeOverride, bonus: CircleRewardType.RANDOM };
        }

        const thresholds = this.hideoutConfig.cultistCircle.craftTimeThreshholds;
        const matchingThreshold = thresholds.find(
            (craftThreshold) => craftThreshold.min <= rewardAmountRoubles && craftThreshold.max >= rewardAmountRoubles,
        );

        // If no threshold fits
        if (!matchingThreshold) {
            // Sanity check that thresholds exist, if not use 12 hours. Otherwise, use the first set.
            let fallbackTimer = 43200;
            if (thresholds[0]?.craftTimeSeconds) {
                fallbackTimer = thresholds[0].craftTimeSeconds;
            }
            return { time: fallbackTimer, bonus: CircleRewardType.RANDOM };
        }

        // Handle 25% chance if over the highest min threshold for a shorter timer. Live is ~0.43 of the base threshold.
        const minThresholds = thresholds.map((a) => a.min);
        const highestThresholdMin = Math.max(...minThresholds);
        if (
            rewardAmountRoubles >= highestThresholdMin &&
            Math.random() <= this.hideoutConfig.cultistCircle.bonusChance
        ) {
            const highestThreshold = thresholds.filter((thresholds) => thresholds.min === highestThresholdMin)[0];
            return {
                time: Math.round(highestThreshold.craftTimeSeconds * this.hideoutConfig.cultistCircle.bonusAmount),
                bonus: CircleRewardType.HIDEOUT,
            };
        }

        // Handle not being in the lowest threshold so qualifying for a "high-value" item
        const maxThresholds = thresholds.map((a) => a.max);
        const lowestMax = Math.min(...maxThresholds);
        if (rewardAmountRoubles >= lowestMax) {
            return { time: matchingThreshold.craftTimeSeconds, bonus: CircleRewardType.VALUABLE_RANDOM };
        }

        return { time: matchingThreshold.craftTimeSeconds, bonus: CircleRewardType.RANDOM };
    }

    /**
     * Get the items player sacrificed in circle
     * @param pmcData Player profile
     * @returns Array of its from player inventory
     */
    protected getSacrificedItems(pmcData: IPmcData): IItem[] {
        // Get root items that are in the cultist sacrifice window
        const inventoryRootItemsInCultistGrid = pmcData.Inventory.items.filter(
            (item) => item.slotId === CircleOfCultistService.circleOfCultistSlotId,
        );

        // Get rootitem + its children
        const sacrificedItems: IItem[] = [];
        for (const rootItem of inventoryRootItemsInCultistGrid) {
            const rootItemWithChildren = this.itemHelper.findAndReturnChildrenAsItems(
                pmcData.Inventory.items,
                rootItem._id,
            );
            sacrificedItems.push(...rootItemWithChildren);
        }

        return sacrificedItems;
    }

    /**
     * Given a pool of items + rouble budget, pick items until the budget is reached
     * @param rewardItemTplPool Items that can be picekd
     * @param rewardBudget Rouble budget to reach
     * @param cultistCircleStashId Id of stash item
     * @returns Array of item arrays
     */
    protected getRewardsWithinBudget(
        rewardItemTplPool: string[],
        rewardBudget: number,
        cultistCircleStashId: string,
    ): IItem[][] {
        // Prep rewards array (reward can be item with children, hence array of arrays)
        const rewards: IItem[][] = [];

        // Pick random rewards until we have exhausted the sacrificed items budget
        let totalRewardCost = 0;
        let rewardItemCount = 0;
        let failedAttempts = 0;
        while (
            totalRewardCost < rewardBudget &&
            rewardItemTplPool.length > 0 &&
            rewardItemCount < this.hideoutConfig.cultistCircle.maxRewardItemCount
        ) {
            if (failedAttempts > this.hideoutConfig.cultistCircle.maxAttemptsToPickRewardsWithinBudget) {
                this.logger.warning(`Exiting reward generation after ${failedAttempts} failed attempts`);

                break;
            }

            // Choose a random tpl from pool
            const randomItemTplFromPool = this.randomUtil.getArrayValue(rewardItemTplPool);

            // Is weapon/armor, handle differently
            if (
                this.itemHelper.armorItemHasRemovableOrSoftInsertSlots(randomItemTplFromPool) ||
                this.itemHelper.isOfBaseclass(randomItemTplFromPool, BaseClasses.WEAPON)
            ) {
                const defaultPreset = this.presetHelper.getDefaultPreset(randomItemTplFromPool);
                if (!defaultPreset) {
                    this.logger.warning(`Reward tpl: ${randomItemTplFromPool} lacks a default preset, skipping reward`);
                    failedAttempts++;

                    continue;
                }

                // Ensure preset has unique ids and is cloned so we don't alter the preset data stored in memory
                const presetAndMods: IItem[] = this.itemHelper.replaceIDs(defaultPreset._items);

                this.itemHelper.remapRootItemId(presetAndMods);

                rewardItemCount++;
                totalRewardCost += this.itemHelper.getItemPrice(randomItemTplFromPool);
                rewards.push(presetAndMods);

                continue;
            }

            // Some items can have variable stack size, e.g. ammo / currency
            const stackSize = this.getRewardStackSize(
                randomItemTplFromPool,
                rewardBudget / (rewardItemCount === 0 ? 1 : rewardItemCount), // Remaining rouble budget
            );

            // Not a weapon/armor, standard single item
            const rewardItem: IItem = {
                _id: this.hashUtil.generate(),
                _tpl: randomItemTplFromPool,
                parentId: cultistCircleStashId,
                slotId: CircleOfCultistService.circleOfCultistSlotId,
                upd: {
                    StackObjectsCount: stackSize,
                    SpawnedInSession: true,
                },
            };

            // Increment price of rewards to give to player + add to reward array
            rewardItemCount++;
            const singleItemPrice = this.itemHelper.getItemPrice(randomItemTplFromPool);
            const itemPrice = singleItemPrice * stackSize;
            totalRewardCost += itemPrice;

            rewards.push([rewardItem]);
        }

        return rewards;
    }

    /**
     * Get direct rewards
     * @param sessionId sessionId
     * @param directReward Items sacrificed
     * @param cultistCircleStashId Id of stash item
     * @returns The reward object
     */
    protected getDirectRewards(
        sessionId: string,
        directReward: IDirectRewardSettings,
        cultistCircleStashId: string,
    ): IItem[][] {
        // Prep rewards array (reward can be item with children, hence array of arrays)
        const rewards: IItem[][] = [];

        // Handle special case of tagilla helmets
        if (directReward.reward.includes(ItemTpl.FACECOVER_TAGILLAS_WELDING_MASK_GORILLA)) {
            directReward.reward = [directReward.reward[Math.round(Math.random())]]; // TODO- mathutil
        }

        // Loop because these can include multiple rewards
        for (const reward of directReward.reward) {
            const stackSize = this.getDirectRewardBaseTypeStackSize(reward);
            const rewardItem: IItem = {
                _id: this.hashUtil.generate(),
                _tpl: reward,
                parentId: cultistCircleStashId,
                slotId: CircleOfCultistService.circleOfCultistSlotId,
                upd: {
                    StackObjectsCount: stackSize,
                    SpawnedInSession: true,
                },
            };
            rewards.push([rewardItem]);
        }
        // Direct reward is not repeatable, flag collected in profile
        if (!directReward.repeatable) {
            this.flagDirectRewardAsAcceptedInProfile(sessionId, directReward);
        }

        return rewards;
    }

    /**
     * Check for direct rewards from what player sacrificed
     * @param sessionId sessionId
     * @param sacrificedItems Items sacrificed
     * @returns Direct reward items to send to player
     */
    protected checkForDirectReward(
        sessionId: string,
        sacrificedItems: IItem[],
        directRewardsCache: Map<string, IDirectRewardSettings>,
    ): IDirectRewardSettings {
        // Get sacrificed tpls
        const sacrificedItemTpls = sacrificedItems.map((item) => item._tpl);

        // Create md5 key of the items player sacrificed so we can compare against the direct reward cache
        const sacrificedItemsKey = this.hashUtil.generateMd5ForData(sacrificedItemTpls.join(","));

        const matchingDirectReward = directRewardsCache.get(sacrificedItemsKey);
        if (!matchingDirectReward) {
            // No direct reward
            return null;
        }

        const fullProfile = this.profileHelper.getFullProfile(sessionId);
        const directRewardHash = this.getDirectRewardHashKey(matchingDirectReward);
        if (fullProfile.spt.cultistRewards.has(directRewardHash)) {
            // Player has already received this direct reward
            return null;
        }

        return matchingDirectReward;
    }

    /**
     * Create an md5 key of the sacrificed + reward items
     * @param directReward Direct reward to create key for
     * @returns Key
     */
    protected getDirectRewardHashKey(directReward: IDirectRewardSettings): string {
        // Key is sacrificed items separated by commas, a dash, then the rewards separated by commas
        const key = `{${directReward.requiredItems.join(",")}-${directReward.reward.join(",")}`;

        return this.hashUtil.generateMd5ForData(key);
    }

    /**
     * Explicit rewards have thier own stack sizes as they dont use a reward rouble pool
     * @param rewardTpl Item being rewarded to get stack size of
     * @returns stack size of item
     */
    protected getDirectRewardBaseTypeStackSize(rewardTpl: string): number {
        const itemDetails = this.itemHelper.getItem(rewardTpl);
        if (!itemDetails[0]) {
            this.logger.warning(`${rewardTpl} is not an item, setting stack size to 1`);

            return 1;
        }

        // Look for parent in dict
        const settings = this.hideoutConfig.cultistCircle.directRewardStackSize[itemDetails[1]._parent];
        if (!settings) {
            return 1;
        }

        return this.randomUtil.getInt(settings.min, settings.max);
    }

    /**
     * Add a record to the players profile to signal they have accepted a non-repeatable direct reward
     * @param sessionId Session id
     * @param directReward Reward sent to player
     */
    protected flagDirectRewardAsAcceptedInProfile(sessionId: string, directReward: IDirectRewardSettings) {
        const fullProfile = this.profileHelper.getFullProfile(sessionId);
        const dataToStoreInProfile: IAcceptedCultistReward = {
            timestamp: this.timeUtil.getTimestamp(),
            sacrificeItems: directReward.requiredItems,
            rewardItems: directReward.reward,
        };

        fullProfile.spt.cultistRewards.set(this.getDirectRewardHashKey(directReward), dataToStoreInProfile);
    }

    /**
     * Get the size of a reward items stack
     * 1 for everything except ammo, ammo can be between min stack and max stack
     * @param itemTpl Item chosen
     * @param rewardPoolRemaining Rouble amount of pool remaining to fill
     * @returns Size of stack
     */
    protected getRewardStackSize(itemTpl: string, rewardPoolRemaining: number) {
        if (this.itemHelper.isOfBaseclass(itemTpl, BaseClasses.AMMO)) {
            const ammoTemplate = this.itemHelper.getItem(itemTpl)[1];
            return this.itemHelper.getRandomisedAmmoStackSize(ammoTemplate);
        }

        if (this.itemHelper.isOfBaseclass(itemTpl, BaseClasses.MONEY)) {
            // Get currency-specific values from config
            const settings = this.hideoutConfig.cultistCircle.currencyRewards[itemTpl];

            // What % of the pool remaining should be rewarded as chosen currency
            const percentOfPoolToUse = this.randomUtil.getInt(settings.min, settings.max);

            // Rouble amount of pool we want to reward as currency
            const roubleAmountToFill = this.randomUtil.getPercentOfValue(percentOfPoolToUse, rewardPoolRemaining);

            // Convert currency to roubles
            const currencyPriceAsRouble = this.itemHelper.getItemPrice(itemTpl);

            // How many items can we fit into chosen pool
            const itemCountToReward = Math.round(roubleAmountToFill / currencyPriceAsRouble);

            return itemCountToReward ?? 1;
        }

        return 1;
    }

    /**
     * Get a pool of tpl IDs of items the player needs to complete hideout crafts/upgrade areas
     * @param sessionId Session id
     * @param pmcData Profile of player who will be getting the rewards
     * @param bonus Do we return bonus items (hideout/task items)
     * @returns Array of tpls
     */
    protected getCultistCircleRewardPool(sessionId: string, pmcData: IPmcData, bonus: CircleRewardType): string[] {
        const rewardPool = new Set<string>();
        const cultistCircleConfig = this.hideoutConfig.cultistCircle;
        const hideoutDbData = this.databaseService.getHideout();

        // Merge reward item blacklist and boss item blacklist with cultist circle blacklist from config
        const itemRewardBlacklist = [
            ...this.seasonalEventService.getInactiveSeasonalEventItems(),
            ...this.itemFilterService.getItemRewardBlacklist(),
            ...cultistCircleConfig.rewardItemBlacklist,
        ];

        // Hideout and task rewards are ONLY if the bonus is active
        switch (bonus) {
            case CircleRewardType.RANDOM:
                // Just random items so we'll add maxRewardItemCount * 2 amount of random things
                this.logger.debug("Generating level 0 cultist loot");
                this.getRandomLoot(rewardPool, itemRewardBlacklist, false);
                break;

            case CircleRewardType.VALUABLE_RANDOM:
                // High value loot only we'll add maxRewardItemCount * 2 amount of random things
                this.logger.debug("Generating level 1 cultist loot");
                this.getRandomLoot(rewardPool, itemRewardBlacklist, true);
                break;

            case CircleRewardType.HIDEOUT: {
                // Hideout/Task loot
                this.logger.debug("Generating level 2 cultist loot");
                // Add hideout upgrade requirements
                const dbAreas = hideoutDbData.areas;
                for (const area of this.getPlayerAccessibleHideoutAreas(pmcData.Hideout.Areas)) {
                    const currentStageLevel = area.level;
                    const areaType = area.type;
                    // Get next stage of area
                    const dbArea = dbAreas.find((area) => area.type === areaType);
                    const nextStageDbData = dbArea.stages[currentStageLevel + 1];
                    if (nextStageDbData) {
                        // Next stage exists, gather up requirements and add to pool
                        const itemRequirements = this.getItemRequirements(nextStageDbData.requirements);
                        for (const rewardToAdd of itemRequirements) {
                            if (
                                itemRewardBlacklist.includes(rewardToAdd.templateId) ||
                                !this.itemHelper.isValidItem(rewardToAdd.templateId)
                            ) {
                                continue;
                            }
                            this.logger.debug(
                                `Added Hideout Loot: ${this.itemHelper.getItemName(rewardToAdd.templateId)}`,
                            );
                            rewardPool.add(rewardToAdd.templateId);
                        }
                    }
                }

                // Add task/quest items
                const activeTasks = pmcData.Quests.filter((quest) => quest.status === QuestStatus.Started);
                for (const task of activeTasks) {
                    const questData = this.questHelper.getQuestFromDb(task.qid, pmcData);
                    const handoverConditions = questData.conditions.AvailableForFinish.filter(
                        (c) => c.conditionType === "HandoverItem",
                    );
                    for (const condition of handoverConditions) {
                        for (const neededItem of condition.target) {
                            if (itemRewardBlacklist.includes(neededItem) || !this.itemHelper.isValidItem(neededItem)) {
                                continue;
                            }
                            this.logger.debug(`Added Task Loot: ${this.itemHelper.getItemName(neededItem)}`);
                            rewardPool.add(neededItem);
                        }
                    }
                }

                // If we have no tasks or hideout stuff left or need more loot to fill it out, default to high value
                if (rewardPool.size < this.hideoutConfig.cultistCircle.maxRewardItemCount + 2) {
                    this.getRandomLoot(rewardPool, itemRewardBlacklist, true);
                }
                break;
            }
        }

        // Add custom rewards from config
        if (cultistCircleConfig.additionalRewardItemPool.length > 0) {
            for (const additionalReward of cultistCircleConfig.additionalRewardItemPool) {
                if (itemRewardBlacklist.includes(additionalReward)) {
                    continue;
                }

                // Add tpl to reward pool
                rewardPool.add(additionalReward);
            }
        }

        return Array.from(rewardPool);
    }

    /**
     * Get all active hideout areas
     * @param areas Hideout areas to iterate over
     * @returns Active area array
     */
    protected getPlayerAccessibleHideoutAreas(areas: IBotHideoutArea[]): IBotHideoutArea[] {
        return areas.filter((area) => {
            if (area.type === HideoutAreas.CHRISTMAS_TREE && !this.seasonalEventService.christmasEventEnabled()) {
                // Christmas tree area and not Christmas, skip
                return false;
            }

            return true;
        });
    }

    /**
     * Get array of random reward items
     * @param rewardPool Reward pool to add to
     * @param itemRewardBlacklist Reward Blacklist
     * @param valuable Should these items meet the valuable threshold
     * @returns rewardPool
     */
    protected getRandomLoot(rewardPool: Set<string>, itemRewardBlacklist: string[], valuable: boolean): Set<string> {
        const allItems = this.itemHelper.getItems();
        let currentItemCount = 0;
        let attempts = 0;
        // currentItemCount var will look for the correct number of items, attempts var will keep this from never stopping if the highValueThreshold is too high
        while (
            currentItemCount < this.hideoutConfig.cultistCircle.maxRewardItemCount + 2 &&
            attempts < allItems.length
        ) {
            attempts++;
            const randomItem = allItems[Math.floor(Math.random() * allItems.length)];
            if (
                itemRewardBlacklist.includes(randomItem._id) ||
                BaseClasses.AMMO === randomItem._parent ||
                BaseClasses.MONEY === randomItem._parent ||
                !this.itemHelper.isValidItem(randomItem._id)
            ) {
                continue;
            }

            // Valuable check
            if (valuable) {
                const itemValue = this.itemHelper.getItemMaxPrice(randomItem._id);
                if (itemValue < this.hideoutConfig.cultistCircle.highValueThreshold) {
                    this.logger.debug(`Ignored due to value: ${this.itemHelper.getItemName(randomItem._id)}`);
                    continue;
                }
            }
            this.logger.debug(`Added: ${this.itemHelper.getItemName(randomItem._id)}`);
            rewardPool.add(randomItem._id);
            currentItemCount++;
        }
        return rewardPool;
    }

    /**
     * Iterate over passed in hideout requirements and return the Item
     * @param requirements Requirements to iterate over
     * @returns Array of item requirements
     */
    protected getItemRequirements(requirements: IRequirementBase[]): (IStageRequirement | IRequirement)[] {
        return requirements.filter((requirement) => requirement.type === "Item");
    }
}

export enum CircleRewardType {
    RANDOM = 0,
    VALUABLE_RANDOM = 1,
    HIDEOUT = 2,
}

export interface ICraftDetails {
    time: number;
    bonus: CircleRewardType;
}

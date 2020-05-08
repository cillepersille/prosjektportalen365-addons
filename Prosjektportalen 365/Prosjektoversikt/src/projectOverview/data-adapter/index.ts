import { Logger, LogLevel } from '@pnp/logging';
import { ICachingOptions } from '@pnp/odata';
import { Site, sp } from '@pnp/sp';
import { taxonomy } from '@pnp/sp-taxonomy';
import format from 'string-format';
import { filter, map, pick } from 'underscore';
import { CONFIG_LIST_NAME, PHASE_FIELD_NAME, PROJECTS_LIST_NAME, PROJECT_COLUMN_CONFIGURATION_LIST_NAME, PROJECT_STATUS_LIST_NAME, STATUS_SECTIONS_LIST_NAME } from '../config';
import { IPortfolioColumnConfigurationItem, IPortfolioItem, IProjectItem, IProjectStatusItem, IStatusSectionItem, Portfolio, ProjectModel, ProjectStatusModel } from '../models';
import { IDataAdapterFetchResult } from './IDataAdapterFetchResult';

export class DataAdapter {
    private cacheOptions: ICachingOptions = null;
    private site: Site;
    private current: Portfolio;
    private cacheKeys = [];

    public usingCaching({ expiration, alias }) {
        this.cacheOptions = {
            expiration,
            key: `${alias}_{0}_{1}`,
        }
        return this;
    }

    protected getCacheOptions(key: string) {
        const cacheKey = format(this.cacheOptions.key, this.current.id, key);
        this.cacheKeys.push(cacheKey);
        return {
            ...this.cacheOptions,
            key: cacheKey,
        }
    }

    private async getPhaseFieldTermSetId(): Promise<string> {
        const { TermSetId } = await sp
            .web
            .fields
            .getByInternalNameOrTitle(PHASE_FIELD_NAME)
            .select('TermSetId')
            .usingCaching(this.getCacheOptions('phase_term_set_id'))
            .get<{ TermSetId: string }>();
        return TermSetId;
    }

    private async searchSitesInHub(siteId: string): Promise<{ [key: string]: string }> {
        const { PrimarySearchResults } = await sp.search({
            Querytext: `DepartmentId:{${siteId}} contentclass:STS_Site`,
            TrimDuplicates: false,
            RowLimit: 500,
            SelectProperties: ['SiteId', 'Title'],
        });
        const sites = PrimarySearchResults.reduce((obj, siteResult) => ({
            ...obj,
            [siteResult['SiteId']]: siteResult['Title'],
        }), {} as { [key: string]: string });
        return sites;
    }

    private async getColumnConfigurations() {
        const items = await this.site.rootWeb.lists.getByTitle(PROJECT_COLUMN_CONFIGURATION_LIST_NAME)
            .items
            .select(
                'GtPortfolioColumnColor',
                'GtPortfolioColumnValue',
                'GtPortfolioColumn/Title',
                'GtPortfolioColumn/GtInternalName'
            )
            .expand('GtPortfolioColumn')
            .filter('startswith(GtPortfolioColumn/GtInternalName,\'GtStatus\')')
            .top(500)
            .usingCaching(this.getCacheOptions('column_configuration'))
            .get<IPortfolioColumnConfigurationItem[]>();
        const columnConfigurations = items.reduce((obj, item) => {
            const key = item.GtPortfolioColumn.GtInternalName;
            obj[key] = obj[key] || {};
            obj[key].name = obj[key].name || item.GtPortfolioColumn.Title;
            obj[key].colors = obj[key].colors || {};
            obj[key].colors[item.GtPortfolioColumnValue] = item.GtPortfolioColumnColor;
            return obj;
        }, {});
        return columnConfigurations;
    }

    public async getPortfolios(): Promise<Portfolio[]> {
        const list = sp.web.lists.getByTitle(CONFIG_LIST_NAME);
        const items = await list
            .items
            .top(500)
            .select('ID', 'Title', 'URL', 'IconName')
            .get<IPortfolioItem[]>();
        return items.map(item => new Portfolio(item));
    }

    public async fetchData(config: Portfolio): Promise<IDataAdapterFetchResult> {
        Logger.log({ message: '(projectOverview/DataAdapter) Fetching data', data: config, level: LogLevel.Info });
        this.current = config;
        this.site = new Site(this.current.url);
        const { Id: siteId } = await this.site.select('Id').get<{ Id: string }>();
        const _phaseTermSetId = await this.getPhaseFieldTermSetId();
        const projectsList = this.site.rootWeb.lists.getByTitle(PROJECTS_LIST_NAME);
        const projectStatusList = this.site.rootWeb.lists.getByTitle(PROJECT_STATUS_LIST_NAME);
        const statusSectionsList = this.site.rootWeb.lists.getByTitle(STATUS_SECTIONS_LIST_NAME);

        const [
            _sites,
            _projects,
            _status,
            _columnConfigurations,
            _statusSections,
            _phases,
        ] = await Promise.all([
            this.searchSitesInHub(siteId),
            projectsList
                .items
                .top(500)
                .usingCaching(this.getCacheOptions('projects'))
                .get<IProjectItem[]>(),
            projectStatusList
                .items
                .top(500)
                .orderBy('Id', false)
                .usingCaching(this.getCacheOptions('project_status'))
                .get<IProjectStatusItem[]>(),
            this.getColumnConfigurations(),
            statusSectionsList
                .items
                .select('GtSecFieldName', 'GtSecIcon')
                .top(10)
                .usingCaching(this.getCacheOptions('status_sections'))
                .get<IStatusSectionItem[]>(),
            taxonomy.getDefaultKeywordTermStore().getTermSetById(_phaseTermSetId).terms.get(),
        ]);


        const status = _status.map(item => new ProjectStatusModel(
            item,
            _columnConfigurations,
            _statusSections,
        ));

        const projects = _projects
            .map(item => {
                const project = new ProjectModel(item, filter(status, s => s.siteId === item.GtSiteId));
                if (!_sites[project.siteId]) return null;
                return project.setTitle(_sites[project.siteId]);
            })
            .filter(p => p);

        const phases =
            map(
                filter(_phases, p => p.LocalCustomProperties.ShowOnFrontpage !== 'false'),
                p => pick(p, 'Name', 'LocalCustomProperties') as any
            );

        return { projects, phases };
    }
}
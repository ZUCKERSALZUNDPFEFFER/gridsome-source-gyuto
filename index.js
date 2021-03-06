/**
 * Gridsome Source Plugin for ZSP Gyuto
 */

const gyuto = require("./gyuto");
const camelCase = require("camelcase");
const { deepMerge, isObject } = require("./helpers/deepMerge");
const { jsonToGraphQLQuery } = require("json-to-graphql-query");

const flatMenuType = require("./types/flatMenuType");

class GyutoSource {
  static defaultOptions() {
    return {
      site: undefined,
      accessToken: undefined,
      environment: "main",
      host: undefined,
      mediaHost: undefined,
      typeName: "GyutoType",
      fieldName: "gyuto",
    };
  }

  constructor(api, options) {
    const { client } = gyuto({
      site: options.site,
      accessToken: options.accessToken,
      host: options.host,
      version: options.version,
      revision: options.revision,
      ressources: options.ressources,
      api,
      options,
    });

    this.api = api;
    this.options = options;
    this.typesIndex = {};
    this.client = client;
    this.config = {};
    console.log("version", this.options.version);
    if (this._getApiVersion(this.options.version) === "api") {
      console.log("Its a rest");
      api.loadSource(async (store) => {
        const { config, menus, site } = await this.client.$get("config/");
        // Create Menus
        await this.createCollection({ store, context: menus, collectionName: "menus", type: flatMenuType });
        // Create MetaData from Gyuto
        // store.addMetadata("siteName", site.site_name);
        store.addMetadata("rootPageId", site.root_page);
        for (const tag in config.custom_meta_tags) {
          store.addMetadata(tag, config.custom_meta_tags[tag]);
        }
        // create Pages
        const hasCustomPageType = this.options.ressources.find((res) => res.endpoint && res.endpoint === "pages");
        if (!hasCustomPageType) {
          await this.createCollection({ store, context: "pages", rootPageId: site.root_page });
        }

        api.createPages(async ({ graphql, createPage }) => {
          const pageRessources = this.options.ressources.filter((res) => res.pageTemplate);
          for (const pageRessource of pageRessources) {
            this.createPagesFrom(pageRessource, createPage, graphql);
          }
        });

        // Create other usefull Collections
        for (const ressource of this.options.ressources) {
          if (ressource.endpoint) {
            await this.createCollection({
              store,
              context: ressource.endpoint,
              type: ressource.type ? ressource.type : null,
              rootPageId: site.root_page,
            });
          } else {
            await this.createCollection({ store, context: ressource, rootPageId: site.root_page });
          }
          //
        }
      });
    }
    if (this._getApiVersion(this.options.version) === "graphql") {
      function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
      }

      function replaceAll(str, find, replace) {
        return str.replace(new RegExp(escapeRegExp(find), "g"), replace);
      }

      const pageFragment = require("./graphql/fragments/PageFragment.js");
      api.createPages(async ({ graphql, createPage }) => {
        // Query our local GraphQL schema to get all sections

        const {
          data: {
            gyuto: { site },
          },
        } = await graphql(`
            query {
              ${this.options.fieldName} {
                site(hostname:"${this.options.site}"){
                  rootPage{
                    ...pageFragment
                  }
                  pages{
                    ...pageFragment
                  }
                }
              }         
            }
            ${pageFragment}
            
                
          `);
        const ressources = this.options.ressources;
        site.pages.forEach((page) => {
          console.log(page.pageType);
          const { pageTemplate } = ressources.find((res) => res.pageTemplate.pageType === page.pageType);
          const pathArray = pageTemplate.path.split(":");
          const pageId = pageTemplate.indexProp ? page[pageTemplate.indexProp] : page.id;
          console.log(pageTemplate, pageId, page.id);

          createPage({
            path: `${pathArray[0]}${pageId}`,
            component: pageTemplate.component,
            context: {
              id: parseInt(page.id),
              slug: page.slug,
              title: page.title,
              pageType: page.pageType,
            },
          });
        });
      });
    }
  }

  async createPagesFrom(ressource, createPage, graphql, rootPageId) {
    const rest = true;
    const { pageTemplate, endpoint, type } = ressource;

    const typeName = `all${this._createTypeNameFor(endpoint)}`;
    const query = { [typeName]: { edges: { node: { ...type } } } };
    const graphql_query = jsonToGraphQLQuery(query);

    const pathArray = pageTemplate.path.split(":");
    const nodeIdentifier = pathArray[pathArray.length - 1];

    const pages = [];

    if (!rest) {
      const { data } = await graphql(`{${graphql_query}}`);
      pages.push(data[typeName].edges);
    } else {
      const { meta, items } = await this.client.$get(endpoint);
      for (const item of items) {
        // only Pages that are not the index.
        if (item.id !== rootPageId) {
          const node = await this.client.$get(this._cleanUrl(item.meta.detail_url));
          pages.push({ node });
        }
      }
    }

    pages.forEach(({ node }) => {
      const pageId = pageTemplate.indexProp ? pageTemplate.indexProp.split(".").reduce((o, i) => o[i], node) : node.id;
      createPage({
        path: `${pathArray[0]}${pageId}`,
        component: pageTemplate.component,
        context: {
          ...node,
        },
      });
    });
  }

  async createCollection({ store, context, collectionName = null, type = null, rootPageId = null }) {
    const name = context.endpoint ? context.endpoint : context;
    const typeName = collectionName ? this._createTypeNameFor(collectionName) : this._createTypeNameFor(name);
    const collection = store.addCollection({ typeName });
    if (!Array.isArray(context)) {
      const route = `${context}/`;
      console.log(context);
      const { meta, items } = await this.client.$get(route);
      for (const item of items) {
        const node = await this.createCollectionNode(item);
        const edge = type ? this._mergeByType(node, type) : node;

        if (context === "pages" && rootPageId) {
          edge.id = edge.id === rootPageId ? "rootPage" : edge.id;

          // ToDo Create custom schemas for components by backend
          edge.components.forEach((comp) => {
            comp.value = isObject(comp.value) ? comp.value : { body: comp.value };
          });
        }

        collection.addNode(edge);
      }
    } else {
      for (const node of context) {
        const edge = type ? this._mergeByType(node, type) : node;
        collection.addNode(edge);
      }
    }
  }
  async createCollectionNode({ meta: { detail_url } }) {
    const node = await this.client.$get(this._cleanUrl(detail_url));
    return node;
  }
  _createTypeNameFor(route = "") {
    return camelCase(`${this.options.typeName} ${route}`, { pascalCase: true });
  }
  _mergeByType(node, type) {
    const typeCopy = JSON.parse(JSON.stringify(type));
    const traverseType = function (obj) {
      for (const k in obj) {
        if (obj[k] !== true) {
          traverseType(obj[k]);
        } else {
          obj[k] = "";
        }
      }
      return obj;
    };

    const mergedNode = deepMerge(traverseType(typeCopy), node);

    return mergedNode;
  }
  _getApiVersion(version) {
    const versions = {
      REST: "api",
      rest: "api",
      graphql: "graphql",
    };
    return versions[version] ? versions[version] : "api";
  }
  _getApiRevision(revision) {
    const revisions = {
      v02: "v2",
    };
    return revisions[revision] ? revisions[revision] : "v2";
  }
  _cleanUrl(detailUrl) {
    const version = this._getApiVersion(this.options.version);
    return `${this.options.host}/${detailUrl.substr(detailUrl.search(version), detailUrl.length)}`;
  }
}

module.exports = GyutoSource;

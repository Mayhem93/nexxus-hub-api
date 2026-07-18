import { Response, Router } from 'express';
import { NexxusHubApiBaseRoute } from '../BaseRoute.ts';
import { NexxusHubApi, NexxusHubApiRequest } from '../Api.ts';
import { InvalidParametersException, NotFoundException } from '../Exceptions.ts';
import {
  NexxusSetting,
  NexxusJsonPatch,
  NEXXUS_SETTING_NAMES,
  type INexxusSetting
} from '@mayhem93/nexxus-core-lib';

interface SettingIdRequest extends NexxusHubApiRequest {
  params: { id: string };
}

interface UpsertSettingRequest extends NexxusHubApiRequest {
  params: { id: string };
  body: { value?: unknown };
}

/**
 * CRUD for the deployment-scoped `setting` builtin model, all through the
 * database instance (`NexxusHubApi.database`).
 *
 *   GET  /setting        list every setting
 *   GET  /setting/:id    fetch one setting (404 if absent)
 *   PUT  /setting/:id    create or update a setting by id
 *   POST /setting/:id    same as PUT
 *
 * No DELETE — removing settings isn't supported. Every route is authenticated
 * by the global `Nxx-Hub-Token` middleware applied in `NexxusHubApi.init()`.
 *
 * Wire shape: the HTTP boundary speaks the parsed JSON `value`; storage holds
 * it JSON-encoded (the `NexxusSetting` contract), so we `JSON.stringify` on
 * write and `getValue()` on read.
 */
export default class SettingRoute extends NexxusHubApiBaseRoute {
  constructor(appRouter: Router) {
    super('/setting', appRouter);
  }

  protected registerRoutes(): void {
    this.router.get('/', this.getAllSettings.bind(this));
    this.router.get('/:id', this.getSetting.bind(this));
    this.router.put('/:id', this.upsertSetting.bind(this));
    this.router.post('/:id', this.upsertSetting.bind(this));
  }

  private async getAllSettings(_req: NexxusHubApiRequest, res: Response): Promise<void> {
    const settings = await NexxusHubApi.database.searchItems({ type: 'setting' });

    res.status(200).json(settings.map((setting) => SettingRoute.serialize(setting)));
  }

  private async getSetting(req: SettingIdRequest, res: Response): Promise<void> {
    const id = req.params.id;

    if (!NexxusSetting.isValidSettingName(id)) {
      throw new InvalidParametersException(`Unknown setting "${id}"`);
    }

    const [setting] = await NexxusHubApi.database.getItems({ ids: [id], type: 'setting' });

    if (!setting) {
      throw new NotFoundException(`Setting "${id}" is not set`);
    }

    res.status(200).json(SettingRoute.serialize(setting));
  }

  private async upsertSetting(req: UpsertSettingRequest, res: Response): Promise<void> {
    const { id } = req.params;

    if (!NexxusSetting.isValidSettingName(id)) {
      throw new InvalidParametersException(
        `Unknown setting "${id}". Known settings: ${NEXXUS_SETTING_NAMES.join(', ')}`
      );
    }

    const { value } = req.body;

    if (value === undefined) {
      throw new InvalidParametersException('"value" is required in the request body');
    }

    const encodedValue = JSON.stringify(value);
    const [existing] = await NexxusHubApi.database.getItems({ ids: [id], type: 'setting' });

    if (existing) {
      // Update — Hub only supports `replace` on a setting's value. No appId in
      // the patch metadata: settings are deployment-scoped.
      const patch = new NexxusJsonPatch({
        op: 'replace',
        path: ['value'],
        value: [encodedValue],
        metadata: { id, type: 'setting' }
      });

      patch.validate(NexxusSetting.getModelSchema());

      await NexxusHubApi.database.updateItems([patch]);

      res.status(200).json({ id, value });

      return;
    }

    // Create
    const setting = new NexxusSetting({ id, value: encodedValue } as INexxusSetting);

    await NexxusHubApi.database.createItems([setting]);

    res.status(200).json(SettingRoute.serialize(setting));
  }

  private static serialize(setting: NexxusSetting): Record<string, unknown> {
    const data = setting.getData();

    return {
      id: data.id,
      value: setting.getValue(),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    };
  }
}

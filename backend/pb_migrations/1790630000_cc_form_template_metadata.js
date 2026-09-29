/// <reference path="../pb_data/types.d.ts" />
// Distinguish registration templates from post-session surveys without changing old versions.
migrate((app) => {
  const templates = app.findCollectionByNameOrId('survey_templates');
  templates.fields.add(new SelectField({ name: 'kind', values: ['survey', 'registration'], maxSelect: 1 }));
  templates.fields.add(new SelectField({ name: 'role_scope', values: ['both', 'speaker', 'listener'], maxSelect: 1 }));
  app.save(templates);
  app.db().newQuery("UPDATE survey_templates SET kind = 'survey', role_scope = 'both'").execute();
  const fields = app.findCollectionByNameOrId('registration_field_defs');
  fields.fields.add(new JSONField({ name: 'config_json' }));
  app.save(fields);
}, (app) => {
  const templates = app.findCollectionByNameOrId('survey_templates');
  templates.fields.removeByName('kind');
  templates.fields.removeByName('role_scope');
  app.save(templates);
  const fields = app.findCollectionByNameOrId('registration_field_defs');
  fields.fields.removeByName('config_json');
  app.save(fields);
});

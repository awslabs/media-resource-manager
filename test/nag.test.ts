// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { addNagChecks } from '../lib/nag';

const nagAspects = (app: App) =>
  Aspects.of(app).all.filter((aspect) => aspect instanceof AwsSolutionsChecks);

describe('addNagChecks', () => {
  test('adds no cdk-nag aspect without the nag flag', () => {
    const app = new App();
    addNagChecks(app);
    expect(nagAspects(app)).toHaveLength(0);
  });

  test.each(['false', false, '1', 'yes'])('adds no cdk-nag aspect for nag=%p', (value) => {
    const app = new App({ context: { nag: value } });
    addNagChecks(app);
    expect(nagAspects(app)).toHaveLength(0);
  });

  test.each(['true', true])('adds the AwsSolutions checks for nag=%p', (value) => {
    const app = new App({ context: { nag: value } });
    addNagChecks(app);
    expect(nagAspects(app)).toHaveLength(1);
  });
});

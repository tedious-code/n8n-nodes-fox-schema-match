import type { INodeType } from 'n8n-workflow';
import { FoxSchemaMatch } from './nodes/FoxSchemaMatch/FoxSchemaMatch.node';

export const nodeTypes: INodeType[] = [new FoxSchemaMatch()];

import { createChannel } from 'reactive-swr/server'
import { schema } from './schema'

export const channel = createChannel(schema)

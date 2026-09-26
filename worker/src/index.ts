import { handleRatings, type RatingsEnv } from './ratings';
import { json } from './http';

export default {
  async fetch(request: Request, env: RatingsEnv): Promise<Response> {
    try {
      return await handleRatings(request, env);
    } catch (error) {
      console.error('[ratings]', error);
      return json({ error: 'Ratings are unavailable. Please try again.' }, 503);
    }
  }
};
